"""The two servers' half of session run settings: briefs carry a session's picks,
/run saves the ones it was sent, enqueue leaves them to the session, and
POST …/session/settings saves a pick and switches the running turn.

Socket-free via Handler.__new__ (the test_context_meter.py pattern).
Spec: docs/superpowers/specs/session-run-settings-design.md
"""

import json
from types import SimpleNamespace

import pytest

from bridge import config, models, queue_manager, relevance, runner, store
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini
from bridge.queue_manager import PreviewQueue

store.init()

CHAT = 555          # config.DASH_CHAT_ID under conftest, and an allowed Mini App user


def _handler(mod):
    h = mod.Handler.__new__(mod.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """Model validation asks models.model_ids(), which would start a Models API
    fetch; a brief of a session with no tool choice asks `claude mcp list` (~6s)."""
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-fable-5-1", "claude-opus-5-5"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])


# --- the briefs -------------------------------------------------------------------

def test_briefs_carry_the_model_and_the_effective_mode():
    s = store.create_session(CHAT, "/srs-brief", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    b = mini._session_brief(store.get_session(s["id"]))
    assert (b["model"], b["permission_mode"]) == ("claude-fable-5-1", "default")
    # No mode stored (a session the bot started): the one an interactive run uses.
    bot = mini._session_brief(store.create_session(CHAT, "/srs-brief-bot"))
    assert bot["model"] is None
    assert bot["permission_mode"] == config.MINIAPP_PERMISSION_MODE


# --- /run saves what it was sent --------------------------------------------------

def _fake_start(monkeypatch, sid):
    seen = {}

    def start(chat, prompt, paths, project=None, **kw):
        seen.update(kw)
        return SimpleNamespace(id="j-run", store_session_id=sid)
    monkeypatch.setattr(runner, "start_streaming_job", start)
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)
    return seen


def _run(surface, body):
    h, box = _handler(dash if surface == "dashboard" else mini)
    (h._run if surface == "dashboard" else h._api_run)(CHAT, body)
    return box


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_run_saves_the_picks_it_was_sent(monkeypatch, surface):
    s = store.create_session(CHAT, f"/srs-run-{surface}", permission_mode="bypassPermissions")
    seen = _fake_start(monkeypatch, s["id"])
    box = _run(surface, {"prompt": "hi", "session_id": s["id"],
                         "model": "claude-fable-5-1", "permission_mode": "default"})
    assert box["code"] == 200
    assert (seen["model"], seen["permission_mode"]) == ("claude-fable-5-1", "default")
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_a_run_without_picks_leaves_the_sessions_alone(monkeypatch, surface):
    s = store.create_session(CHAT, f"/srs-run0-{surface}", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    _fake_start(monkeypatch, s["id"])
    assert _run(surface, {"prompt": "hi", "session_id": s["id"]})["code"] == 200
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")


# --- enqueue leaves model + mode to the session ------------------------------------

@pytest.fixture()
def held_queue(monkeypatch):
    q = PreviewQueue(run_fn=lambda item: None, persist_path=None)   # busy: items stay queued
    monkeypatch.setattr(queue_manager, "_instance", q)
    return q


def test_dashboard_enqueue_drops_model_and_mode(held_queue):
    h, box = _handler(dash)
    h._queue("enqueue", CHAT, {"session_id": "s-q-dash", "text": "later", "effort": "high",
                               "model": "claude-opus-5-5", "permission_mode": "default"})
    assert box["code"] == 200
    [it] = held_queue.snapshot("s-q-dash")["items"]
    assert (it["model"], it["permission_mode"], it["effort"]) == (None, None, "high")


def test_miniapp_enqueue_drops_model_and_mode(held_queue):
    s = store.create_session(CHAT, "/srs-q-mini")
    h, box = _handler(mini)
    h._api_queue_post(CHAT, {"op": "enqueue", "session_id": s["id"], "prompt": "later",
                             "effort": "high", "model": "claude-opus-5-5",
                             "permission_mode": "default"})
    assert box["code"] == 200
    [it] = held_queue.snapshot(s["id"])["items"]
    assert (it["model"], it["permission_mode"], it["effort"]) == (None, None, "high")


# --- POST …/session/settings ----------------------------------------------------

def _settings(surface, body, chat=CHAT):
    """The route as each server dispatches it (the Mini App's past its initData gate)."""
    if surface == "dashboard":
        h, box = _handler(dash)
        h._post_api("/local/session/settings", body)
        return box
    h, box = _handler(mini)
    h._auth = lambda: chat
    h._read_json = lambda: body
    h.path = "/api/session/settings"
    h.do_POST()
    return box


class _Stdin:
    def __init__(self):
        self.lines = []

    def write(self, s):
        self.lines.append(json.loads(s))

    def flush(self):
        pass


PERM = {"request_id": "p1", "kind": "permission", "tool_name": "Bash",
        "summary": "touch a", "input": {"command": "touch a"}}
QUESTION = {"request_id": "q1", "kind": "question", "tool_name": "AskUserQuestion",
            "questions": []}


def _answer(job):
    """The CLI accepting every control request written so far (it answers each
    on stdout; only then is a switch real)."""
    for line in [l for l in job.proc.stdin.lines if l["type"] == "control_request"]:
        runner._handle_event(job, {"type": "control_response", "response": {
            "subtype": "success", "request_id": line["request_id"], "response": {}}})


def _live(monkeypatch, sid, *pending):
    """A fake in-flight turn for `sid`, registered where apply_run_settings looks."""
    monkeypatch.setattr(runner, "_jobs", {})
    job = runner.Job("j-" + sid, CHAT, sid)
    job.proc = SimpleNamespace(stdin=_Stdin(), poll=lambda: None)
    for p in pending:
        job.add_pending(dict(p))
    runner._register(job)
    return job


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_a_pick_is_saved_and_switches_the_running_turn(monkeypatch, surface):
    s = store.create_session(CHAT, f"/srs-pick-{surface}", permission_mode="default")
    job = _live(monkeypatch, s["id"], PERM, QUESTION)
    box = _settings(surface, {"session_id": s["id"], "model": "claude-fable-5-1",
                              "permission_mode": "bypassPermissions"})
    assert box["code"] == 200
    assert box["obj"] == {"ok": True, "model": "claude-fable-5-1",
                          "permission_mode": "bypassPermissions"}
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "bypassPermissions")
    lines = job.proc.stdin.lines
    assert [l["request"] for l in lines if l["type"] == "control_request"] == [
        {"subtype": "set_model", "model": "claude-fable-5-1"},
        {"subtype": "set_permission_mode", "mode": "bypassPermissions"}]
    _answer(job)
    # The waiting permission card is approved; the question still waits on you.
    assert [l["response"]["request_id"] for l in lines if l["type"] == "control_response"] == ["p1"]
    assert [p["request_id"] for p in job.pending] == ["q1"]


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_with_nothing_running_the_save_is_enough(monkeypatch, surface):
    monkeypatch.setattr(runner, "_jobs", {})
    s = store.create_session(CHAT, f"/srs-idle-{surface}")
    box = _settings(surface, {"session_id": s["id"], "permission_mode": "plan"})
    assert box["code"] == 200
    assert box["obj"] == {"ok": True, "model": None, "permission_mode": "plan"}
    assert store.get_session(s["id"])["permission_mode"] == "plan"


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
@pytest.mark.parametrize("bad", [{"model": "gpt-5"}, {"permission_mode": "yolo"},
                                 {"model": 5}, {"permission_mode": ["bypassPermissions"]}])
def test_an_invalid_pick_is_a_400_and_changes_nothing(monkeypatch, surface, bad):
    s = store.create_session(CHAT, f"/srs-bad-{surface}", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-opus-5-5")
    job = _live(monkeypatch, s["id"], PERM)
    # A valid half beside the bad one must not slip through on its own.
    box = _settings(surface, {"session_id": s["id"], "model": "claude-fable-5-1",
                              "permission_mode": "plan", **bad})
    assert box["code"] == 400
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-opus-5-5", "default")
    assert job.proc.stdin.lines == [] and [p["request_id"] for p in job.pending] == ["p1"]


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_someone_elses_session_is_a_404(monkeypatch, surface):
    mine = store.create_session(CHAT, f"/srs-mine-{surface}")
    assert _settings(surface, {"session_id": mine["id"], "model": "claude-opus-5-5"})["code"] == 200
    other = store.create_session(999, f"/srs-other-{surface}", permission_mode="default")
    job = _live(monkeypatch, other["id"], PERM)
    box = _settings(surface, {"session_id": other["id"], "permission_mode": "bypassPermissions"})
    assert box["code"] == 404
    assert store.get_session(other["id"])["permission_mode"] == "default"
    assert job.proc.stdin.lines == []
    assert _settings(surface, {"permission_mode": "plan"})["code"] == 404   # no id at all


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_a_pick_that_keeps_the_mode_approves_nothing(monkeypatch, surface):
    """The pickers POST the pair they show, so a model-only pick re-sends the
    session's own mode. That is no switch: a turn running in another mode (a
    tracker update runs `manual` with a confirmation card, inside a session
    stored as bypassPermissions) keeps its card waiting on you."""
    s = store.create_session(CHAT, f"/srs-keep-{surface}", permission_mode="bypassPermissions")
    store.set_run_settings(s["id"], model="claude-opus-5-5")
    job = _live(monkeypatch, s["id"], PERM)
    box = _settings(surface, {"session_id": s["id"], "model": "claude-fable-5-1",
                              "permission_mode": "bypassPermissions"})
    assert box["code"] == 200
    assert store.get_session(s["id"])["model"] == "claude-fable-5-1"
    assert [l["request"] for l in job.proc.stdin.lines] == [
        {"subtype": "set_model", "model": "claude-fable-5-1"}]
    assert [p["request_id"] for p in job.pending] == ["p1"]       # still yours to answer
