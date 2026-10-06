"""The Rivendell channel (docs/superpowers/specs/rivendell-channel.md): what the
bridge itself knows about a Rivendell job — the session that ran it, what that
run is doing or came to, the question it is held on — and the state of the link
the job arrived over.

No network and no Claude: workers are driven directly, every Telegram message
lands in the `quiet` fixture, and the store is conftest's temp DB (store.init()
is idempotent, so each helper that needs tables calls it).
Run: python -m pytest tests/test_rivendell_channel.py -v
"""

import itertools
import json
import socket
import threading
import time
import uuid

import pytest

from bridge import config, rivendell, runner, state, store, wsutil

_mids = itertools.count(1000)          # Telegram message ids, unique across tests


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    """Every Telegram message a worker or a hook would send, recorded instead of
    sent: {"chat", "text", "kb", "mid"}. The generic run pings (runner._notify)
    are silenced too. NOTIFY_ENABLE and the Mini App URL are pinned here: the
    bridge exports .env into the shells it hosts, and conftest pins neither."""
    from bridge import telegram
    sent = []

    def send(chat_id, text, reply_markup=None):
        sent.append({"chat": chat_id, "text": text, "kb": reply_markup, "mid": next(_mids)})
        return {"message_id": sent[-1]["mid"]}
    monkeypatch.setattr(telegram, "send", send)
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    monkeypatch.setattr(config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(state, "miniapp_url", None)        # no OPEN SESSION button to count
    return sent


@pytest.fixture
def workers():
    """The running-worker registry, emptied around the test."""
    store.init()
    rivendell._workers.clear()
    yield rivendell._workers
    rivendell._workers.clear()


@pytest.fixture
def jobs():
    """Jobs a test registers with the runner, dropped again afterwards."""
    made = []
    yield made
    with runner._jobs_lock:
        for j in made:
            runner._jobs.pop(j.id, None)


def _inst(**kw):
    d = {"id": "ch", "name": "test", "enable": True,
         "api_url": "http://api.example:3001", "token": "rvd_testtoken",
         "ws_url": "", "model": "opus", "workdir": "",
         "review_timeout": 3600, "impl_timeout": 10800}
    d.update(kw)
    return d


def _worker(**kw):
    return rivendell.Worker(_inst(**kw))


def _answering(answer):
    """An _api stand-in that returns a fresh copy of `answer` for every call."""
    return lambda path, payload=None: json.loads(json.dumps(answer))


def _session(origin="rivendell:test", title="Inbox: group meeting action items by client"):
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "proj", origin=origin)["id"]
    if title:
        store.rename(sid, title)
    return sid


def _turn(sid, *, status="done", elapsed=60, result=None, error=None, tokens=None):
    """One finished turn on `sid`, with the events a run would have journaled.
    Turn ids are a global primary key, hence the uuid."""
    tid = uuid.uuid4().hex
    store.start_turn(sid, tid, "implement it", None)
    if error:
        store.append_event(sid, tid, {"type": "error", "message": error})
    if result is not None:
        store.append_event(sid, tid, {"type": "result", "result": result})
    store.set_turn_tokens(tid, tokens)
    store.finish_turn(tid, status, None, elapsed)
    return tid


def _tasks(*rids, status="COMPLETED"):
    """A /plugin/tasks answer: one of the user's tasks per request id."""
    return {"projects": [{"id": "p1", "name": "Rivendell", "url": "https://rv/projects/p1"}],
            "tasks": [{"id": f"t{i}", "name": f"Task {i}", "mine": True, "implementation":
                       {"id": rid, "status": status, "createdAt": "2026-10-06T10:00:00Z",
                        "completedAt": None}}
                      for i, rid in enumerate(rids, 1)]}


def _wait_until(pred, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met within timeout")


# --- Task 1: every run is filed under its request ------------------------------

def test_sessions_are_found_by_their_request_ref():
    a, b = _session(), _session()
    store.set_ref(a, "ch:r-find-1")
    store.set_ref(b, "ch:r-find-2")
    assert store.sessions_for_refs(["ch:r-find-1", "ch:r-find-2", "ch:nope"]) == {
        "ch:r-find-1": a, "ch:r-find-2": b}
    assert store.sessions_for_refs([]) == {}


def test_a_request_run_again_names_its_newest_session():
    """A catch-up after a restart re-claims an IN_PROGRESS request and runs it in
    a new session; the card must open the one that did the work it now shows."""
    old, new = _session(), _session()
    store.set_ref(old, "ch:r-again")
    store.set_ref(new, "ch:r-again")
    assert store.sessions_for_refs(["ch:r-again"]) == {"ch:r-again": new}


def test_track_files_the_session_under_the_request(workers):
    sid = _session()
    _worker()._track("r-track", "impl", "acme/app", sid, label=None, link=None)
    assert store.sessions_for_refs(["ch:r-track"]) == {"ch:r-track": sid}


def test_a_finished_run_keeps_its_session_on_the_card(workers):
    """OPEN SESSION used to vanish with the run (memory only). A DONE card now
    still knows the session that did the work — after a restart too."""
    sid = _session()
    store.set_ref(sid, "ch:r-done")
    w = _worker()
    w._api = _answering(_tasks("r-done"))
    workers["ch"] = w
    assert rivendell.tasks("acme/app")["tasks"][0]["session_id"] == sid
