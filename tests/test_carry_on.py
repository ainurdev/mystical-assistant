"""Carry-on: one Mystical-sent turn after a session switched an MCP server on."""

from types import SimpleNamespace

import pytest

from bridge import carry_on, store

store.init()


@pytest.fixture(autouse=True)
def _queue(monkeypatch):
    """No real turn starts: an enqueue lands in `got`; `items` is the queue."""
    from bridge import queue_manager
    got, items = [], []
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: got.append((sid, kw)) or "q1")
    monkeypatch.setattr(queue_manager, "snapshot", lambda sid: {"items": items})
    return SimpleNamespace(got=got, items=items)


def _sid() -> str:
    s = store.create_session(556, "/carryon", origin="dashboard")
    return s["id"] if isinstance(s, dict) else s


def _job(sid, **kw):
    return SimpleNamespace(store_session_id=sid, status=kw.get("status", "done"),
                           interrupted=kw.get("interrupted", False), chat_id=556)


def test_switch_on_then_normal_end_queues_one_tagged_carry_on(_queue):
    sid = _sid()
    carry_on.mark(sid, ["playwright"])
    carry_on.mark(sid, ["github"])                # two switches, one turn: one carry-on
    assert carry_on.after_turn(_job(sid), resumed=False) is True
    (qsid, kw), = _queue.got
    assert qsid == sid and kw["surface"] == "carry-on"
    assert kw["text"].startswith("[mystical]") and "github, playwright" in kw["text"]
    assert carry_on.after_turn(_job(sid), resumed=False) is False   # spent


@pytest.mark.parametrize("job_kw", [{"status": "error"}, {"interrupted": True}])
def test_bad_end_queues_nothing_and_forgets(_queue, job_kw):
    sid = _sid()
    carry_on.mark(sid, ["playwright"])
    assert carry_on.after_turn(_job(sid, **job_kw), resumed=False) is False
    assert carry_on.after_turn(_job(sid), resumed=False) is False   # not saved for later
    assert _queue.got == []


def test_a_goal_or_flow_that_resumes_wins(_queue):
    sid = _sid()
    carry_on.mark(sid, ["playwright"])
    assert carry_on.after_turn(_job(sid), resumed=True) is False
    assert carry_on.after_turn(_job(sid), resumed=False) is False   # the goal's turn doesn't fire it
    assert _queue.got == []


def test_your_own_queued_message_wins(_queue):
    sid = _sid()
    carry_on.mark(sid, ["playwright"])
    _queue.items.append({"status": "running"})   # yours, started as the turn ended
    assert carry_on.after_turn(_job(sid), resumed=False) is False
    assert _queue.got == []


def test_no_switch_no_carry_on(_queue):
    assert carry_on.after_turn(_job(_sid()), resumed=False) is False
    assert _queue.got == []
