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
