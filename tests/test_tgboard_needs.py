"""The Live board's Needs-you rows, its session buttons, the caption's "needs you"
and the last two turns when quiet (bridge/tgboard.py, ticket telegram-widgets 04).
Same seam as test_tgboard: a recorder for telegram.tg, jobs in the runner's registry,
and the Needs-you list the dashboard's bell reads (notices.needs)."""

import json

import pytest

from bridge import notices, runner, state, store, tgboard
from test_tgboard import CHAT, NOW, methods, sent_data, tg, turn  # noqa: F401 — tg is a fixture


def need(kind, sid, title, body="", at=NOW - 120, verb=None):
    return {"subject": sid, "kind": kind, "verb": verb or notices.verb(kind), "title": title,
            "body": body, "at": at, "session_id": None if kind == "rv_offer" else sid, "meta": {}}


@pytest.fixture
def needing(monkeypatch):
    """Set what notices.needs answers; it is handed the status map, as the bell's is."""
    box = {"list": [], "status": None}

    def fake(status):
        box["status"] = status
        return box["list"]
    monkeypatch.setattr(notices, "needs", fake)
    return box


def kb(calls):
    return json.loads([p for m, p in calls if m in ("sendWidget", "editMessageCaption")][-1]["reply_markup"])


@pytest.mark.parametrize("kind,v", [
    ("question", "asks"), ("approve", "approve"), ("login", "sign in"), ("limit_choice", "limit"),
    ("goal_blocked", "goal"), ("credits", "credits"), ("rv_offer", "offered")])
def test_each_kind_of_needs_you_is_one_row_with_its_verb_text_and_wait(tg, needing, kind, v):
    turn("busy")
    needing["list"] = [need(kind, "s-" + kind + "-123456", "pr review flow", "which layout? · 3 options")]
    tgboard.look(NOW)
    row = sent_data(tg)["rows"][-1]
    assert row == {"k": ("s-" + kind + "-123456")[:8], "c": "n", "t": "pr review flow", "s": "which layout? · 3 options",
                   "a": int(NOW - 120), "v": v}
    assert needing["status"] is not None


def test_a_real_ask_comes_through_the_bells_list(tg):
    sid, job = turn("pr review flow")
    job.pending = [{"kind": "question", "request_id": "r1"}]
    store.start_turn(sid, job.id, "go", None)          # the status map's running ids come from turns
    notices.emit("question", sid, body="which layout? · 3 options")
    try:
        tgboard.look(NOW)
    finally:
        store.finish_turn(job.id, "done", None, None)
    d = sent_data(tg)
    assert [(r["c"], r["v"], r["s"]) for r in d["rows"]] == [("n", "asks", "which layout? · 3 options")]
    assert tg[0][1]["caption"] == "1 running · 1 needs you"   # held on its ask, and still running


def test_running_rows_first_then_needs_each_newest_first(tg, needing):
    a, _ = turn("old run", started=NOW - 300)
    b, _ = turn("new run", started=NOW - 10)
    needing["list"] = [need("question", "q-new", "new ask", at=NOW - 5),
                       need("login", "q-old", "old ask", at=NOW - 500)]
    tgboard.look(NOW)
    assert [r["t"] for r in sent_data(tg)["rows"]] == ["new run", "old run", "new ask", "old ask"]


def test_past_seven_rows_running_rows_go_first(tg, needing):
    for i in range(6):
        turn(f"run{i}", started=NOW - 100 + i)
    needing["list"] = [need("question", f"ask{i}xxxxx", f"ask{i}", at=NOW - i) for i in range(4)]
    tgboard.look(NOW)
    d = sent_data(tg)
    assert [r["t"] for r in d["rows"]] == ["run5", "run4", "run3", "ask0", "ask1", "ask2", "ask3"]
    assert d["more"] == 3
    assert tg[0][1]["caption"] == "6 running · 4 needs you"


def test_the_byte_limit_drops_running_rows_before_any_needs_row(tg, needing):
    long = "جلسهٔ بازبینی طراحی صفحهٔ اصلی " * 3
    for i in range(5):
        turn(long + str(i), step="🔧" * 40, out=123456, started=NOW - i)
    needing["list"] = [need("approve", f"need{i}xxxx", long, "🔧" * 40, at=NOW - i) for i in range(3)]
    tgboard.look(NOW)
    raw = [p for m, p in tg if m == "sendWidget"][0]["chat_data"]
    assert len(raw.encode()) <= tgboard.DATA_MAX
    kinds = [r["c"] for r in json.loads(raw)["rows"]]
    assert kinds.count("n") == 3 and kinds == sorted(kinds, key=lambda c: c == "n")


def test_caption_reads_nothing_running_with_needs(tg, needing):
    _, job = turn()
    tgboard.look(NOW)
    job.status = "done"
    needing["list"] = [need("login", "s-login-1", "Fix login")]
    tgboard.look(NOW + 5)
    assert [p for m, p in tg if m == "editMessageCaption"][-1]["caption"] == "nothing running · 1 needs you"


def test_buttons_one_per_session_newest_first_at_most_three_then_open_panel(tg, needing):
    turn()
    needing["list"] = [
        need("question", "sid-ask", "pr review flow", at=NOW - 1),
        need("question", "sid-ask", "pr review flow", at=NOW - 2),     # the same session again
        need("rv_offer", "rv:w:1", "teammate job", at=NOW - 3),        # no session to open
        need("approve", "sid-apr", "deploy", at=NOW - 4),
        need("login", "sid-log", "Fix login", at=NOW - 5),
        need("credits", "sid-cre", "fourth", at=NOW - 6)]
    tgboard.look(NOW)
    u = "https://mini.example"
    assert kb(tg) == {"inline_keyboard": [
        [{"text": "◈ Answer · pr review flow", "web_app": {"url": u + "?s=sid-ask"}}],
        [{"text": "◈ Answer · deploy", "web_app": {"url": u + "?s=sid-apr"}}],
        [{"text": "◈ Open · Fix login", "web_app": {"url": u + "?s=sid-log"}}],
        [{"text": "◈ Open panel", "web_app": {"url": u}}]]}


def test_buttons_follow_the_mini_apps_address_and_vanish_without_one(tg, needing, monkeypatch):
    turn()
    needing["list"] = [need("question", "sid-ask", "pr review flow")]
    tgboard.look(NOW)
    monkeypatch.setattr(state, "miniapp_url", "https://moved.example")
    tgboard.look(NOW + 5)
    assert all("moved.example" in b[0]["web_app"]["url"] for b in kb(tg)["inline_keyboard"])
    monkeypatch.setattr(state, "miniapp_url", None)
    tgboard.look(NOW + 10)
    assert kb(tg) == {"inline_keyboard": []}


def test_quiet_board_carries_the_last_two_turns_that_ended(tg, needing):
    a, job = turn("widgets grill")
    b, _ = turn("rivendell team tab")
    c, _ = turn("older")
    tgboard.look(NOW)
    runner._jobs.clear()
    notices.emit("done", c, body="old")
    notices.emit("failed", b, body="Tests: 3 failed")
    notices.emit("parked", a)                          # not an ending: skipped
    notices.emit("done", a, body="All good", meta={"elapsed": 372})
    tgboard.look(NOW + 5)
    last = sent_data(tg)["last"]
    assert [(x["t"], x["s"], x.get("ok")) for x in last] == [
        ("widgets grill", "done · 6 min", 1), ("rivendell team tab", "failed · Tests: 3 failed", None)]
    assert all(isinstance(x["a"], int) for x in last)


def test_no_last_turns_while_anything_runs_or_waits(tg, needing):
    sid, _ = turn()
    notices.emit("done", sid)
    tgboard.look(NOW)
    assert "last" not in sent_data(tg)
    runner._jobs.clear()
    needing["list"] = [need("login", "s-login-1", "Fix login")]
    tgboard.look(NOW + 5)
    assert "last" not in sent_data(tg) and sent_data(tg)["rows"][0]["c"] == "n"


def test_a_needs_row_with_no_known_wait_carries_no_time(tg, needing):
    turn()
    needing["list"] = [need("question", "s-ask-123", "ask", at=None)]
    tgboard.look(NOW)
    assert "a" not in sent_data(tg)["rows"][-1]
