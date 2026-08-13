"""Unit tests for bridge/attribution.py — where a session's wall clock went.
Run: python -m pytest tests/test_attribution.py -v"""

import json
import os
import sys
import time
from contextlib import closing

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from bridge import attribution, config, store  # noqa: E402


# --- fixtures ----------------------------------------------------------------
# append_event() stamps ts with time.time(), so a test that wants two calls to
# overlap has to place them itself. These write the same rows by hand.

def _session(chat_id: int = 555) -> str:
    store.init()
    s = store.create_session(chat_id, "/proj")
    return s["id"] if isinstance(s, dict) else s


def _turn(session_id: str, turn_id: str, *, status: str = "done",
          elapsed: int | None = 10) -> str:
    """turns.id is unique suite-wide and the test DB is shared, so scope the
    caller's short name to its session."""
    tid = f"{session_id}:{turn_id}"
    store.start_turn(session_id, tid, "p", None)
    store.finish_turn(tid, status, None, elapsed)
    return tid


def _event(session_id: str, turn_id: str, ev: dict, ts: float) -> None:
    """append_event with a caller-chosen ts."""
    with closing(store._connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        seq = c.execute("SELECT COALESCE(MAX(seq),-1)+1 AS n FROM events "
                        "WHERE session_id=?", (session_id,)).fetchone()["n"]
        c.execute("INSERT INTO events(session_id,turn_id,seq,type,payload,ts) "
                  "VALUES(?,?,?,?,?,?)",
                  (session_id, turn_id, seq, ev.get("type", ""),
                   json.dumps(ev), ts))
        c.execute("COMMIT")


def _tool(session_id: str, turn_id: str, name: str, tid: str,
          start: float, dur_s: float) -> None:
    """A completed tool call occupying [start, start+dur_s]."""
    _event(session_id, turn_id, {"type": "tool", "name": name, "id": tid,
                                 "summary": name}, start)
    _event(session_id, turn_id, {"type": "tool_done", "id": tid,
                                 "ms": int(dur_s * 1000), "output": "",
                                 "is_error": False}, start + dur_s)


# --- union math (pure) -------------------------------------------------------

def test_overlapping_intervals_count_their_covered_span_once():
    # 0-10 and 5-15 cover 15s of wall clock, not 20s.
    assert attribution.merge_intervals([(0, 10), (5, 15)]) == pytest.approx(15)


def test_disjoint_intervals_sum_to_their_total():
    assert attribution.merge_intervals([(0, 10), (20, 25)]) == pytest.approx(15)


def test_interval_fully_contained_in_another_adds_nothing():
    assert attribution.merge_intervals([(0, 100), (10, 20)]) == pytest.approx(100)


def test_merge_intervals_of_nothing_is_zero():
    assert attribution.merge_intervals([]) == 0


# --- per-tool attribution ----------------------------------------------------

def test_serial_calls_of_one_tool_report_naive_equal_to_union():
    """The A1 finding: 26 subagents that never overlapped. naive == union is the
    signal that parallelising them is still available as a fix."""
    sid = _session()
    tid = _turn(sid, "t1", elapsed=100)
    _tool(sid, tid, "Agent", "a1", 1000.0, 30)
    _tool(sid, tid, "Agent", "a2", 1030.0, 30)

    agent = attribution.breakdown(sid)["tools"]["Agent"]

    assert agent["calls"] == 2
    assert agent["union_s"] == pytest.approx(60)
    assert agent["naive_s"] == pytest.approx(60)


def test_concurrent_calls_of_one_tool_report_union_below_naive():
    sid = _session()
    tid = _turn(sid, "t1", elapsed=100)
    _tool(sid, tid, "Bash", "b1", 1000.0, 10)
    _tool(sid, tid, "Bash", "b2", 1005.0, 10)

    bash = attribution.breakdown(sid)["tools"]["Bash"]

    assert bash["naive_s"] == pytest.approx(20)
    assert bash["union_s"] == pytest.approx(15)


def test_tool_started_but_never_finished_is_counted_as_unfinished():
    """A turn killed at the cap leaves a `tool` with no `tool_done`. Ten of those
    in the motivating session — dropping them silently under-reports."""
    sid = _session()
    tid = _turn(sid, "t1", status="error", elapsed=config.RUN_TIMEOUT)
    _event(sid, tid, {"type": "tool", "name": "Agent", "id": "orphan",
                      "summary": "Agent"}, 1000.0)

    agent = attribution.breakdown(sid)["tools"]["Agent"]

    assert agent["unfinished"] == 1
    assert agent["union_s"] == 0


# --- waiting on a human ------------------------------------------------------

def test_askuserquestion_is_reported_as_waiting_not_as_tool_time():
    """31.6 minutes of AskUserQuestion is the human thinking, not the session
    being slow. It gets its own line and must not appear under tools."""
    sid = _session()
    tid = _turn(sid, "t1", elapsed=100)
    _tool(sid, tid, "AskUserQuestion", "q1", 1000.0, 40)

    b = attribution.breakdown(sid)

    assert b["waiting_s"] == pytest.approx(40)
    assert "AskUserQuestion" not in b["tools"]


# --- the remainder -----------------------------------------------------------

def test_model_time_is_wall_clock_minus_everything_attributed():
    sid = _session()
    tid = _turn(sid, "t1", elapsed=100)
    _tool(sid, tid, "Bash", "b1", 1000.0, 30)
    _event(sid, tid, {"type": "thinking", "ms": 20000}, 1050.0)

    b = attribution.breakdown(sid)

    assert b["wall"] == pytest.approx(100)
    assert b["thinking_s"] == pytest.approx(20)
    assert b["model_s"] == pytest.approx(50)


def test_thinking_overlapping_a_tool_is_not_subtracted_twice():
    """One merge pass across every interval, not three unions added together."""
    sid = _session()
    tid = _turn(sid, "t1", elapsed=100)
    _tool(sid, tid, "Bash", "b1", 1000.0, 30)
    # thinking 1010-1030 sits entirely inside the Bash call
    _event(sid, tid, {"type": "thinking", "ms": 20000}, 1030.0)

    assert attribution.breakdown(sid)["model_s"] == pytest.approx(70)


def test_model_time_clamps_at_zero_when_attribution_overshoots_wall():
    sid = _session()
    tid = _turn(sid, "t1", elapsed=5)
    _tool(sid, tid, "Bash", "b1", 1000.0, 60)

    assert attribution.breakdown(sid)["model_s"] == 0


# --- capped turns ------------------------------------------------------------

def test_turn_that_errored_at_the_cap_counts_as_capped():
    sid = _session()
    _turn(sid, "t1", status="error", elapsed=config.RUN_TIMEOUT)

    assert attribution.breakdown(sid)["capped"] == 1


def test_turn_that_finished_past_the_cap_is_not_capped():
    """Turn 13 of the motivating session finished `done` at 3126s after an
    internal resume. Elapsed alone would misread it as killed."""
    sid = _session()
    _turn(sid, "t1", status="done", elapsed=config.RUN_TIMEOUT + 1326)

    assert attribution.breakdown(sid)["capped"] == 0


def test_short_error_turn_is_not_capped():
    sid = _session()
    _turn(sid, "t1", status="error", elapsed=3)

    assert attribution.breakdown(sid)["capped"] == 0


# --- tokens ------------------------------------------------------------------

def test_tokens_sum_across_turns():
    sid = _session()
    for n, (i, o) in enumerate([(100, 10), (200, 20)]):
        tid = _turn(sid, f"t{n}")
        store.set_turn_tokens(tid, {"in": i, "out": o, "cache_w": 1, "cache_r": 2})

    assert attribution.breakdown(sid)["tokens"] == {
        "in": 300, "out": 30, "cache_w": 2, "cache_r": 4}


def test_tokens_are_none_when_no_turn_recorded_them():
    """A pre-deploy session must read as unknown, never as free."""
    sid = _session()
    _turn(sid, "t1")

    assert attribution.breakdown(sid)["tokens"] is None


def test_recorded_zero_tokens_is_not_reported_as_unknown():
    sid = _session()
    tid = _turn(sid, "t1")
    store.set_turn_tokens(tid, {"in": 0, "out": 0, "cache_w": 0, "cache_r": 0})

    assert attribution.breakdown(sid)["tokens"] == {
        "in": 0, "out": 0, "cache_w": 0, "cache_r": 0}


# --- degenerate input --------------------------------------------------------

def test_session_with_no_turns_returns_a_zeroed_breakdown():
    sid = _session()

    b = attribution.breakdown(sid)

    assert b["wall"] == 0
    assert b["tools"] == {}
    assert b["model_s"] == 0
    assert b["capped"] == 0


def test_unknown_session_does_not_raise():
    assert attribution.breakdown("no-such-session")["wall"] == 0


def test_tool_done_with_missing_ms_contributes_nothing_but_still_counts():
    sid = _session()
    tid = _turn(sid, "t1", elapsed=10)
    _event(sid, tid, {"type": "tool", "name": "Read", "id": "r1",
                      "summary": "Read"}, 1000.0)
    _event(sid, tid, {"type": "tool_done", "id": "r1", "output": "",
                      "is_error": False}, 1000.0)

    read = attribution.breakdown(sid)["tools"]["Read"]

    assert read["calls"] == 1
    assert read["union_s"] == 0
