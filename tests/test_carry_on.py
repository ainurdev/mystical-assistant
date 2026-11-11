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
                           interrupted=kw.get("interrupted", False), chat_id=556,
                           bg_ended=kw.get("bg_ended", []))


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


# --- a background command the bridge ended with the turn ---------------------------------
# A session that ends its turn to wait on a background command never hears of it: the
# watchdog ends the command with the finished turn (runner.BG_SHELL_GRACE) and nothing
# wakes the session. 80 turns in 70 sessions lost one that way, 2026-10-18 to 11-10.

def test_a_turn_that_lost_a_background_command_is_told_to_run_it_again(_queue):
    sid = _sid()
    lost = ["Run full backend suite", "Wait for full suite to finish"]
    assert carry_on.after_turn(_job(sid, bg_ended=lost), resumed=False) is True
    (qsid, kw), = _queue.got
    assert qsid == sid and kw["surface"] == "carry-on" and kw["text"] == kw["prompt"]
    assert kw["text"].startswith("No path for this message.\n\n[mystical]")   # an order, not a bug to route
    assert "Run full backend suite; Wait for full suite to finish" in kw["text"]
    assert "in the foreground" in kw["text"]


def test_the_carry_on_for_a_lost_command_is_sent_once(_queue):
    sid = _sid()
    carry_on.after_turn(_job(sid, bg_ended=["Run the suite"]), resumed=False)
    store.start_turn(sid, "t-carried", _queue.got[0][1]["prompt"], None)   # its own turn loses one too
    assert carry_on.after_turn(_job(sid, bg_ended=["Run the suite"]), resumed=False) is False
    assert len(_queue.got) == 1


@pytest.mark.parametrize("origin", ["ticket", "ticket-merge", "rivendell:someone", "automation", "helper"])
def test_only_a_session_you_talk_to_is_told(_queue, origin):
    """tickets.py carries a ticket or merge session on itself, and counts; a job, an
    automation or a helper has handed its result on by the time its turn ends."""
    s = store.create_session(556, "/carryon", origin=origin)
    assert carry_on.after_turn(_job(s["id"], bg_ended=["Run the suite"]), resumed=False) is False
    assert _queue.got == []


@pytest.mark.parametrize("job_kw", [{"status": "error"}, {"interrupted": True}])
def test_a_stopped_or_failed_turn_that_lost_a_command_is_left_alone(_queue, job_kw):
    assert carry_on.after_turn(_job(_sid(), bg_ended=["Run the suite"], **job_kw), resumed=False) is False
    assert _queue.got == []


def test_a_lost_command_waits_behind_a_flow_step_or_your_own_message(_queue):
    sid = _sid()
    assert carry_on.after_turn(_job(sid, bg_ended=["Run the suite"]), resumed=True) is False
    _queue.items.append({"status": "queued"})
    assert carry_on.after_turn(_job(sid, bg_ended=["Run the suite"]), resumed=False) is False
    assert _queue.got == []


def test_a_switched_on_mcp_and_a_lost_command_share_one_carry_on(_queue):
    sid = _sid()
    carry_on.mark(sid, ["github"])
    assert carry_on.after_turn(_job(sid, bg_ended=["Run the suite"]), resumed=False) is True
    (_, kw), = _queue.got
    assert "Run the suite" in kw["text"] and "MCP loaded: github" in kw["text"]
