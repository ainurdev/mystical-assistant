"""Outcomes as both surfaces actually receive them: on the turn rows of
`store.transcript()`, and counted in the weekly report.

There is no endpoint of its own to test — the outcome rides the transcript
payload the dashboard and the Mini App already poll, which is the whole reason
neither client needed a new route or 404 tolerance.
Run: python -m pytest tests/test_outcomes_store.py -v
"""

import itertools
import os
import sys
from contextlib import closing
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import report, store  # noqa: E402

_chat = itertools.count(930_000)
NOW = datetime(2026, 8, 19, 15, 0).timestamp()   # a Wednesday, as in test_report


def _session() -> tuple[int, str]:
    store.init()
    chat = next(_chat)
    return chat, store.create_session(chat, "proj")["id"]


def _failed(sid: str, tid: str, *, events: list[dict], elapsed: int = 5,
            cost: float | None = 0.1, started: float | None = None) -> None:
    store.start_turn(sid, tid, "prompt", None)
    for ev in events:
        store.append_event(sid, tid, ev)
    store.finish_turn(tid, "error", cost, elapsed)
    if started is not None:
        with closing(store._connect()) as c:
            c.execute("UPDATE turns SET started=? WHERE id=?", (started, tid))


def test_transcript_carries_the_outcome_of_a_failed_turn():
    _, sid = _session()
    _failed(sid, "t-del", events=[{"type": "text", "text": "working"},
                                  {"type": "result", "result": "here it is"}])
    turn = store.transcript(sid)["turns"][0]
    assert turn["outcome"]["code"] == "delivered"
    assert turn["outcome"]["label"] and turn["outcome"]["detail"]


def test_a_healthy_turn_carries_no_outcome_key():
    """Absent, not null-with-a-label: the badge must not render on a green turn."""
    _, sid = _session()
    store.start_turn(sid, "t-ok", "prompt", None)
    store.append_event(sid, "t-ok", {"type": "result", "result": "done"})
    store.finish_turn("t-ok", "done", 0.1, 5)
    assert "outcome" not in store.transcript(sid)["turns"][0]


def test_the_orphan_flip_reads_as_interrupted_through_the_store():
    """claim_orphaned_turns leaves no reason behind; the transcript supplies one."""
    _, sid = _session()
    store.start_turn(sid, "t-orph", "prompt", None)
    store.append_event(sid, "t-orph", {"type": "text", "text": "half a thought"})
    assert store.claim_orphaned_turns()          # running -> error, silently
    turn = next(t for t in store.transcript(sid)["turns"] if t["id"] == "t-orph")
    assert turn["outcome"]["code"] == "interrupted"


def test_the_outcome_survives_an_incremental_poll():
    """The badge must not blink out when a later poll passes a cursor past the
    events the classification was read from."""
    _, sid = _session()
    _failed(sid, "t-inc", events=[{"type": "text", "text": "hi"},
                                  {"type": "result", "result": ""}])
    full = store.transcript(sid)
    later = store.transcript(sid, cursor=full["next_cursor"])
    assert not later["events"]                   # nothing new
    assert later["turns"][0]["outcome"]["code"] == "empty"


def test_week_failures_groups_by_code_in_the_report():
    chat, sid = _session()
    _failed(sid, "w1", events=[{"type": "text", "text": "x"},
                               {"type": "result", "result": "answer"}], started=NOW)
    _failed(sid, "w2", events=[{"type": "text", "text": "x"},
                               {"type": "result", "result": "answer"}], started=NOW)
    _failed(sid, "w3", events=[{"type": "error", "message": "claude exited -9"}],
            started=NOW)
    rep = report.weekly(chat, now=NOW)
    codes = {f["code"]: f["n"] for f in rep["failures"]}
    assert codes == {"delivered": 2, "restarted": 1}
    body = report.render(rep)
    assert "2 turns ended badly" not in body      # 3 failed, not 2
    assert "3 turns ended badly" in body
    assert "2× answer delivered" in body


def test_a_clean_week_gets_no_failure_section():
    chat, sid = _session()
    store.start_turn(sid, "ok1", "prompt", None)
    store.finish_turn("ok1", "done", 0.1, 30)
    with closing(store._connect()) as c:
        c.execute("UPDATE turns SET started=? WHERE id=?", (NOW, "ok1"))
    rep = report.weekly(chat, now=NOW)
    assert rep["failures"] == []
    assert "ended badly" not in report.render(rep)
