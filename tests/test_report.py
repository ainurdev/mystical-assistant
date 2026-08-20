"""Weekly per-project report: window math, aggregation, unknown-vs-zero tokens,
and the Monday-push due logic.
Run: python -m pytest tests/test_report.py -v"""

import itertools
import os
import sys
from contextlib import closing
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import report, store  # noqa: E402

# 2026-08-19 is a Wednesday; its week runs Mon Aug 17 00:00 → Mon Aug 24 00:00.
NOW = datetime(2026, 8, 19, 15, 0).timestamp()

_chat = itertools.count(910_000)


def _fresh_chat() -> int:
    store.init()
    return next(_chat)


def _turn(sid: str, tid: str, started: float, elapsed: int = 60,
          tokens: dict | None = None, model: str | None = None) -> None:
    store.start_turn(sid, tid, "p", None, model=model)
    store.finish_turn(tid, "done", None, elapsed)
    if tokens:
        store.set_turn_tokens(tid, tokens)
    with closing(store._connect()) as c:
        c.execute("UPDATE turns SET started=? WHERE id=?", (started, tid))


def _at(y, m, d, h=12) -> float:
    return datetime(y, m, d, h).timestamp()


# --- window math -------------------------------------------------------------

def test_week_bounds_are_monday_to_monday_local():
    since, until = report.week_bounds(NOW)
    assert since == datetime(2026, 8, 17).timestamp()
    assert until == datetime(2026, 8, 24).timestamp()


def test_week_bounds_back_one_is_the_completed_week():
    since, until = report.week_bounds(NOW, back=1)
    assert since == datetime(2026, 8, 10).timestamp()
    assert until == datetime(2026, 8, 17).timestamp()


# --- aggregation -------------------------------------------------------------

def test_weekly_groups_sessions_turns_and_time_by_project():
    chat = _fresh_chat()
    a1 = store.create_session(chat, "/proj-a")["id"]
    a2 = store.create_session(chat, "/proj-a")["id"]
    b = store.create_session(chat, "/proj-b")["id"]
    _turn(a1, f"{a1}:1", _at(2026, 8, 17), elapsed=100)
    _turn(a2, f"{a2}:1", _at(2026, 8, 18), elapsed=50)
    _turn(a2, f"{a2}:2", _at(2026, 8, 18, 13), elapsed=50)
    _turn(b, f"{b}:1", _at(2026, 8, 19), elapsed=30)

    rep = report.weekly(chat, now=NOW)

    by_name = {p["project"]: p for p in rep["projects"]}
    assert by_name["/proj-a"]["sessions"] == 2
    assert by_name["/proj-a"]["turns"] == 3
    assert by_name["/proj-a"]["elapsed"] == 200
    assert by_name["/proj-b"]["turns"] == 1
    assert rep["totals"]["sessions"] == 3
    assert rep["totals"]["turns"] == 4
    assert rep["totals"]["elapsed"] == 230
    # Busiest project first — the report reads top-down.
    assert rep["projects"][0]["project"] == "/proj-a"


def test_weekly_excludes_turns_outside_the_window():
    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj")["id"]
    _turn(sid, f"{sid}:in", _at(2026, 8, 17))
    _turn(sid, f"{sid}:before", _at(2026, 8, 3))

    rep = report.weekly(chat, now=NOW)

    assert rep["totals"]["turns"] == 1


def test_weekly_tokens_unknown_is_none_not_zero():
    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj")["id"]
    _turn(sid, f"{sid}:1", _at(2026, 8, 17))  # predates token recording

    rep = report.weekly(chat, now=NOW)

    assert rep["projects"][0]["tokens"] is None
    assert rep["totals"]["tokens"] is None


def test_weekly_sums_all_four_token_counters():
    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj")["id"]
    _turn(sid, f"{sid}:1", _at(2026, 8, 17),
          tokens={"in": 10, "out": 20, "cache_w": 30, "cache_r": 40})
    _turn(sid, f"{sid}:2", _at(2026, 8, 18), tokens={"in": 1, "out": 2})

    rep = report.weekly(chat, now=NOW)

    assert rep["projects"][0]["tokens"] == 103
    assert rep["totals"]["tokens"] == {"in": 11, "out": 22, "cache_w": 30,
                                       "cache_r": 40}


def test_weekly_lists_models_used_per_project():
    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj")["id"]
    _turn(sid, f"{sid}:1", _at(2026, 8, 17), model="claude-opus-5")
    _turn(sid, f"{sid}:2", _at(2026, 8, 18), model=None)

    rep = report.weekly(chat, now=NOW)

    assert rep["projects"][0]["models"] == ["claude-opus-5"]


def test_weekly_days_bucket_by_local_date():
    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj")["id"]
    _turn(sid, f"{sid}:1", _at(2026, 8, 17, 9), elapsed=10)
    _turn(sid, f"{sid}:2", _at(2026, 8, 17, 22), elapsed=20)
    _turn(sid, f"{sid}:3", _at(2026, 8, 19, 9), elapsed=30)

    rep = report.weekly(chat, now=NOW)

    assert rep["days"] == [
        {"day": "2026-08-17", "turns": 2, "elapsed": 30},
        {"day": "2026-08-19", "turns": 1, "elapsed": 30},
    ]


def test_weekly_carries_previous_week_totals_for_the_delta():
    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj")["id"]
    _turn(sid, f"{sid}:now", _at(2026, 8, 18), elapsed=40)
    _turn(sid, f"{sid}:prev", _at(2026, 8, 12), elapsed=70)

    rep = report.weekly(chat, now=NOW)

    assert rep["prev"]["turns"] == 1
    assert rep["prev"]["elapsed"] == 70


# --- rendering ---------------------------------------------------------------

def test_render_names_projects_and_never_prices():
    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj-x")["id"]
    _turn(sid, f"{sid}:1", _at(2026, 8, 17), elapsed=3600,
          tokens={"in": 500, "out": 1500})

    text = report.render(report.weekly(chat, now=NOW))

    assert "proj-x" in text
    # Time and tokens, never dollars — the CLI prices subscription runs at API
    # list rate, so a dollar line here would be a made-up number (see 9f612a4).
    assert "$" not in text


def test_render_bolds_through_telegrams_own_converter():
    """render() emits markdown, not HTML: send() runs every message through
    _md_to_html, which escapes < and > — so a pre-baked <b> shipped as the
    literal text "<b>" (the first week's push did exactly that)."""
    from bridge.telegram import _md_to_html

    chat = _fresh_chat()
    sid = store.create_session(chat, "/proj-x")["id"]
    _turn(sid, f"{sid}:1", _at(2026, 8, 17), elapsed=3600)

    html = _md_to_html(report.render(report.weekly(chat, now=NOW)))

    assert "<b>proj-x</b>" in html
    assert "&lt;" not in html


def test_render_survives_an_empty_week():
    chat = _fresh_chat()

    text = report.render(report.weekly(chat, now=NOW))

    assert text  # says "nothing", never raises


# --- Monday-push due logic ---------------------------------------------------

def test_pending_week_waits_for_monday_nine():
    monday_0850 = datetime(2026, 8, 17, 8, 50).timestamp()
    assert report.pending_week(monday_0850, last_sent=None) is None


def test_pending_week_fires_monday_morning():
    monday_0910 = datetime(2026, 8, 17, 9, 10).timestamp()
    assert report.pending_week(monday_0910, last_sent=None) == \
        datetime(2026, 8, 10).timestamp()


def test_pending_week_catches_up_when_the_bridge_slept_through_monday():
    # Machine was off Monday morning; first boot Wednesday still owes the report.
    assert report.pending_week(NOW, last_sent=None) == \
        datetime(2026, 8, 10).timestamp()


def test_pending_week_never_double_sends():
    sent = datetime(2026, 8, 10).timestamp()
    assert report.pending_week(NOW, last_sent=sent) is None


# --- the /report command -----------------------------------------------------

def test_report_command_sends_the_weekly_report(monkeypatch):
    from bridge import dispatch
    store.init()
    sent = []
    monkeypatch.setattr(dispatch, "send",
                        lambda chat, text, kb=None: sent.append(text))
    dispatch.on_message({"chat": {"id": 555}, "text": "/report"})
    dispatch.on_message({"chat": {"id": 555}, "text": "/report last"})
    assert len(sent) == 2
    assert all("Week" in t for t in sent)


def test_report_command_is_in_help():
    from bridge import dispatch
    assert "/report" in dispatch.HELP
