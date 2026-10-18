"""Waits: WaitForSession resolves and records a wait, the status map reads it,
a target's quiet end wakes its waiters through their own queue, and any new
turn on the waiter ends it."""

import json
import os
import types

import pytest

from bridge import queue_manager, runner, state, store, tailstate, waits

store.init()
CHAT = 4242


def _session(title: str, cwd: str = "") -> str:
    s = store.create_session(CHAT, "/waittest", origin="dashboard")
    sid = s["id"] if isinstance(s, dict) else s
    store.rename(sid, title)
    if cwd:
        store.set_cwd(sid, cwd)
    return sid


@pytest.fixture(autouse=True)
def fresh(monkeypatch, tmp_path):
    """Empty waits, persisted under tmp; busy map, queue and pings captured."""
    monkeypatch.setattr(waits, "_waits", {})
    monkeypatch.setattr(waits, "_loaded", True)
    monkeypatch.setattr(waits, "_path", lambda: str(tmp_path / "waits.json"))
    box = {"busy": {}, "queued": [], "pings": []}
    monkeypatch.setattr(waits, "_busy", lambda chat_id: box["busy"])
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: box["queued"].append((sid, kw)) or "q1")
    monkeypatch.setattr(runner, "_notify", lambda chat_id, text, kb=None, **kw: box["pings"].append(kw))
    monkeypatch.setattr(state, "is_running", lambda sid: False)
    return box


def _job(sid, status="done", result="", error=None, elapsed=840):
    return types.SimpleNamespace(store_session_id=sid, chat_id=CHAT, status=status, result=result,
                                 texts=[], error_msg=error, elapsed=elapsed, ask_dismissed=False)


def test_add_resolves_a_busy_session_by_title_words(fresh):
    a, b = _session("Git Tab Replaces Header Icon"), _session("Smooth GIT Tab Layout Transitions")
    fresh["busy"] = {b: {"state": "working", "label": "working…"}}
    text = waits.add(CHAT, a, "the git tab layout session", "rebase onto it")
    assert "Waiting on Smooth GIT Tab Layout Transitions" in text
    w = waits.get(a)
    assert w["on"] == b and w["then"] == "rebase onto it" and w["chat_id"] == CHAT


def test_add_takes_an_id_prefix_and_a_worktree_name(fresh):
    a = _session("Waiter")
    b = _session("Some Title", cwd="/x/.worktrees/repo/feat-git-readout")
    fresh["busy"] = {b: {"state": "working", "label": "working…"}}
    assert "Waiting on" in waits.add(CHAT, a, b[:8], "go")
    waits.drop(a)
    assert "Waiting on" in waits.add(CHAT, a, "feat/git-readout", "go")


def test_add_refuses_an_idle_session(fresh):
    a, b = _session("Waiter"), _session("Long Finished Thing")
    text = waits.add(CHAT, a, "long finished thing", "go")
    assert "isn't running anything" in text
    assert waits.get(a) is None


def test_add_refuses_two_busy_matches_and_lists_them(fresh):
    a, b, c = _session("Waiter"), _session("Docs pass one"), _session("Docs pass two")
    fresh["busy"] = {b: {"state": "working", "label": "x"}, c: {"state": "working", "label": "y"}}
    text = waits.add(CHAT, a, "docs pass", "go")
    assert "More than one" in text and b[:8] in text and c[:8] in text
    assert waits.get(a) is None


def test_add_needs_then_and_never_waits_on_itself(fresh):
    a, b = _session("Self Waiter"), _session("Other")
    fresh["busy"] = {a: {"state": "working", "label": "x"}, b: {"state": "working", "label": "y"}}
    assert "then" in waits.add(CHAT, a, "other", "  ")
    assert "No session matches" in waits.add(CHAT, a, "self waiter", "go")


def test_question_mark_lists_what_is_running(fresh):
    a, b = _session("Waiter"), _session("Busy One")
    fresh["busy"] = {b: {"state": "working", "label": "Polishing"}}
    text = waits.add(CHAT, a, "?", "")
    assert "Busy One" in text and b[:8] in text


def test_a_wait_back_on_your_own_waiter_is_refused(fresh):
    a, b = _session("A side"), _session("B side")
    fresh["busy"] = {a: {"state": "working", "label": "x"}, b: {"state": "waiting", "label": "y"}}
    waits.add(CHAT, b, "a side", "go")              # B waits on A
    text = waits.add(CHAT, a, "b side", "go")       # A waiting on B would deadlock
    assert "deadlock" in text and waits.get(a) is None


def test_waits_survive_a_restart(fresh, monkeypatch):
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    waits.add(CHAT, a, "target", "merge it")
    with open(waits._path(), encoding="utf-8") as f:          # noqa: SLF001
        assert json.load(f)[a]["on"] == b
    monkeypatch.setattr(waits, "_waits", {})
    monkeypatch.setattr(waits, "_loaded", False)
    assert waits.get(a)["then"] == "merge it"


def test_a_target_that_finishes_quietly_wakes_its_waiters(fresh):
    a, b = _session("Waiter"), _session("Smooth Transitions")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    waits.add(CHAT, a, "smooth transitions", "rebase the readout")
    waits.target_ended(_job(b, result="Notes.\n\nMerged to master as 3 commits."))
    assert waits.get(a) is None
    (sid, kw), = fresh["queued"]
    assert sid == a and kw["surface"] == "wait"
    assert kw["prompt"].startswith("⧖ Smooth Transitions finished — done in 14m.")
    assert 'It ended with: "Merged to master as 3 commits."' in kw["prompt"]
    assert "You were waiting to: rebase the readout. Carry on." in kw["prompt"]
    assert fresh["pings"][-1]["kind"] == "resumed" and fresh["pings"][-1]["sid"] == a


def test_a_failed_target_wakes_them_with_the_error(fresh):
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    waits.add(CHAT, a, "target", "merge")
    waits.target_ended(_job(b, status="error", error="tests failed"))
    (_, kw), = fresh["queued"]
    assert "Target failed — tests failed." in kw["prompt"] and "check before you go ahead" in kw["prompt"]


def test_a_target_busy_again_or_waiting_itself_keeps_them_waiting(fresh, monkeypatch):
    a, b, c = _session("A"), _session("B target"), _session("C target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}, c: {"state": "working", "label": "y"}}
    waits.add(CHAT, a, "b target", "go")
    monkeypatch.setattr(state, "is_running", lambda sid: sid == b)    # its queue started the next prompt
    waits.target_ended(_job(b))
    assert waits.get(a) and not fresh["queued"]
    monkeypatch.setattr(state, "is_running", lambda sid: False)
    waits.add(CHAT, b, "c target", "go")                               # a chain: B now waits on C
    waits.target_ended(_job(b))
    assert waits.get(a) and not fresh["queued"]


def test_resume_now_wakes_early_and_cancel_just_drops(fresh):
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    waits.add(CHAT, a, "target", "merge")
    assert waits.resume(a) is True
    (_, kw), = fresh["queued"]
    assert "resumed you before Target finished" in kw["prompt"] and waits.get(a) is None
    waits.add(CHAT, a, "target", "merge")
    assert waits.drop(a) is True and waits.get(a) is None and len(fresh["queued"]) == 1
    assert waits.resume(a) is False


def test_an_archived_target_drops_the_wait(fresh):
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    waits.add(CHAT, a, "target", "merge")
    store.archive(b)
    assert a not in waits.active() and waits.get(a) is None


def test_status_map_reads_waiting_after_working(fresh):
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    waits.add(CHAT, a, "target", "merge")
    st = runner._build_status([], [], [], [], {})                     # noqa: SLF001
    assert st[a]["state"] == "waiting" and st[a]["on"] == b and st[a]["then"] == "merge"
    assert st[a]["label"] == "waiting on Target"
    assert runner._build_status([a], [], [], [], {})[a]["state"] == "working"   # noqa: SLF001


def test_tailstate_pings_waiting_not_done_and_wakes_the_chain(fresh, monkeypatch):
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    monkeypatch.setattr(tailstate, "needs_you", lambda *a, **k: None)
    waits.add(CHAT, a, "target", "merge")
    tailstate._run(_job(a, result="Waiting on Target."), None)        # noqa: SLF001
    assert fresh["pings"][-1]["kind"] == "waiting" and not fresh["queued"]
    tailstate._run(_job(b, result="All done."), None)                 # noqa: SLF001
    assert [p["kind"] for p in fresh["pings"][-2:]] == ["done", "resumed"]
    assert fresh["queued"][0][0] == a


def test_a_target_that_ends_asking_you_keeps_them_waiting(fresh, monkeypatch):
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    monkeypatch.setattr(tailstate, "needs_you", lambda *a, **k: "approve or revise?")
    monkeypatch.setattr(runner, "notify_needs_you", lambda *a, **k: None)
    waits.add(CHAT, a, "target", "merge")
    tailstate._run(_job(b, result="Approve or revise?"), None)        # noqa: SLF001
    assert waits.get(a) and not fresh["queued"]


# --- the routes and the tool ------------------------------------------------

def _dash_handler():
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    return h, box


def test_wait_route_binds_the_calling_session(fresh, monkeypatch):
    from bridge.dashboard import server as dash
    monkeypatch.setattr(dash, "_chat", lambda: CHAT)
    a, b = _session("Waiter"), _session("Target")
    store.set_claude_session_id(a, "csid-wait-a")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    h, box = _dash_handler()
    h._post_api("/local/wait", {"claude_session_id": "csid-wait-a", "session": "target", "then": "merge"})  # noqa: SLF001
    assert "Waiting on Target" in box["obj"]["text"] and waits.get(a)["on"] == b
    h._post_api("/local/wait", {"claude_session_id": "nobody", "session": "target", "then": "x"})  # noqa: SLF001
    assert "can't wait" in box["obj"]["text"]


def test_resume_and_cancel_routes_check_ownership(fresh, monkeypatch):
    from bridge.dashboard import server as dash
    monkeypatch.setattr(dash, "_chat", lambda: CHAT)
    a, b = _session("Waiter"), _session("Target")
    fresh["busy"] = {b: {"state": "working", "label": "x"}}
    waits.add(CHAT, a, "target", "merge")
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{a}/wait", {"action": "cancel"})      # noqa: SLF001
    assert box["obj"] == {"ok": True} and waits.get(a) is None
    other = store.create_session(999, "/notyours")
    h._post_api(f"/local/sessions/{other['id'] if isinstance(other, dict) else other}/wait",  # noqa: SLF001
                {"action": "resume"})
    assert box["code"] == 404
    h._post_api(f"/local/sessions/{a}/wait", {"action": "nap"})          # noqa: SLF001
    assert box["code"] == 400


def test_the_tool_posts_to_the_bridge(monkeypatch):
    from bridge import goal_mcp
    seen = {}

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"text": "Waiting on Target."}'

    def fake_open(req, timeout=0):
        seen.update(url=req.full_url, body=json.loads(req.data), token=req.get_header("X-dash-token"))
        return R()
    monkeypatch.setattr(goal_mcp.urllib.request, "urlopen", fake_open)
    monkeypatch.setenv("MYSTICAL_DASH", "http://127.0.0.1:1")
    monkeypatch.setenv("MYSTICAL_DASH_TOKEN", "tok")
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "csid-x")
    assert goal_mcp._wait({"session": "target", "then": "merge"}) == "Waiting on Target."   # noqa: SLF001
    assert seen["url"].endswith("/local/wait") and seen["token"] == "tok"
    assert seen["body"] == {"session": "target", "then": "merge", "claude_session_id": "csid-x"}
