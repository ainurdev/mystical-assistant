"""bridge/notices.py — the feed every surface reads, its prefs, and the
Telegram routing (docs/superpowers/specs/notifications.md)."""

import time
from contextlib import closing
from datetime import datetime

import pytest

from bridge import config, notices, store


@pytest.fixture(autouse=True)
def _clean_feed(monkeypatch):
    store.init()
    with closing(store._connect()) as c:
        c.execute("DELETE FROM notices")
    store.set_setting("notify_prefs", None)
    monkeypatch.setattr(notices, "_last_seen", float("-inf"))
    monkeypatch.setattr(config, "NOTIFY_ENABLE", True)
    yield


# --- the feed ---------------------------------------------------------------

def test_emit_and_feed_newest_first():
    a = notices.emit("done", "s1", title="First", body="ok", meta={"elapsed": 12})
    b = notices.emit("pr_failing", "pr:o/r:x", title="#9 · x", body="lint")
    rows = notices.feed()
    assert [r["id"] for r in rows] == [b, a]
    assert rows[1]["meta"] == {"elapsed": 12}
    assert rows[1]["group"] == "done" and rows[1]["tier"] == "news" and rows[1]["source"] == "session"
    assert rows[0]["verb"] == "CHECKS FAILING" and rows[0]["source"] == "pr"
    assert rows[0]["read"] is False


def test_feed_fills_session_title():
    s = store.create_session(555, "/repo", origin="dashboard")
    with closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=? WHERE id=?", ("Fix the weather chip", s["id"]))
    notices.emit("failed", s["id"], body="Out of context")
    row = notices.feed()[0]
    assert row["title"] == "Fix the weather chip"
    assert row["meta"]["project"] == "/repo"


def test_rivendell_verb_follows_job_kind():
    notices.emit("rv_done", "rv:i:1", title="PR #212", meta={"job_kind": "review"})
    notices.emit("rv_done", "rv:i:2", title="Task 6", meta={"job_kind": "impl"})
    notices.emit("rv_done", "rv:i:3", title="Changelog", meta={"job_kind": "changelog"})
    assert [r["verb"] for r in notices.feed()] == ["DONE", "IMPLEMENTED", "REVIEWED"]


def test_prune_drops_week_old():
    old = notices.emit("done", "s-old", title="old")
    with closing(store._connect()) as c:
        c.execute("UPDATE notices SET at=? WHERE id=?", (time.time() - 8 * 86400, old))
    notices.emit("done", "s-new", title="new")
    assert [r["subject"] for r in notices.feed()] == ["s-new"]


def test_feed_caps_at_200():
    for i in range(205):
        store.add_notice("done", f"s{i}", "t", "", {})
    assert len(notices.feed()) == 200


def test_mark_read_ids_and_all():
    a = notices.emit("done", "s1", title="a")
    b = notices.emit("done", "s2", title="b")
    assert notices.mark_read([a]) == 1
    assert {r["id"]: r["read"] for r in notices.feed()} == {a: True, b: False}
    assert notices.mark_read(None) == 1
    assert all(r["read"] for r in notices.feed())


def test_emit_unknown_kind_is_refused():
    assert notices.emit("nonsense", "s1", title="x") is None
    assert notices.feed() == []


def test_emit_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("disk full")
    monkeypatch.setattr(store, "add_notice", boom)
    assert notices.emit("done", "s1", title="x") is None


# --- prefs --------------------------------------------------------------------

def test_prefs_defaults_and_patch():
    p = notices.prefs()
    assert p["events"]["done"] == {"pop": True, "sound": "chime", "tg": "away"}
    assert p["events"]["account"]["tg"] == "always"
    assert p["quiet"] == {"on": False, "from": "22:00", "to": "09:00", "needs": True}
    assert p["away_min"] == 5
    p = notices.set_prefs({"events": {"done": {"tg": "always"}}, "quiet": {"on": True}})
    assert p["events"]["done"]["tg"] == "always" and p["quiet"]["on"] is True
    assert notices.prefs()["events"]["done"]["tg"] == "always"
    # A value outside the allowed set, an unknown group and a bad time are ignored.
    p = notices.set_prefs({"events": {"done": {"tg": "loud", "sound": "gong"}, "nope": {"pop": True}},
                           "quiet": {"from": "25:99"}, "away_min": -3})
    assert p["events"]["done"]["tg"] == "always" and p["events"]["done"]["sound"] == "chime"
    assert "nope" not in p["events"] and p["quiet"]["from"] == "22:00" and p["away_min"] == 5


def test_prefs_bad_json_defaults():
    store.set_setting("notify_prefs", "{nope")
    assert notices.prefs()["events"]["done"]["tg"] == "away"
    store.set_setting("notify_prefs", '{"events": {"done": "x"}, "quiet": 3, "away_min": "a"}')
    p = notices.prefs()
    assert p["events"]["done"]["pop"] is True and p["quiet"]["on"] is False and p["away_min"] == 5


# --- routing --------------------------------------------------------------------

def test_telegram_ok_matrix(monkeypatch):
    notices.set_prefs({"events": {"done": {"tg": "off"}, "failed": {"tg": "always"},
                                  "parked": {"tg": "away"}}})
    assert notices.telegram_ok("done") is False
    assert notices.telegram_ok("failed") is True
    notices.seen(time.time())                      # someone is at a dashboard
    assert notices.telegram_ok("parked") is False
    notices.seen(time.time() - 6 * 60)             # an older report never moves it back
    assert notices.telegram_ok("parked") is False
    monkeypatch.setattr(notices, "_last_seen", time.time() - 6 * 60)
    assert notices.telegram_ok("parked") is True   # nobody clicked for 6 min > 5
    monkeypatch.setattr(config, "NOTIFY_ENABLE", False)
    assert notices.telegram_ok("failed") is False
    assert notices.telegram_ok("nonsense") is False


def test_quiet_spans_midnight():
    notices.set_prefs({"quiet": {"on": True, "from": "22:00", "to": "09:00"}})
    at = lambda h, m: datetime(2026, 10, 16, h, m)  # noqa: E731
    assert notices.quiet(at(23, 30)) is True
    assert notices.quiet(at(8, 59)) is True
    assert notices.quiet(at(9, 0)) is False
    assert notices.quiet(at(14, 0)) is False
    notices.set_prefs({"quiet": {"from": "13:00", "to": "15:00"}})
    assert notices.quiet(at(14, 0)) is True and notices.quiet(at(23, 30)) is False
    notices.set_prefs({"quiet": {"on": False}})
    assert notices.quiet(at(14, 0)) is False


def test_quiet_lets_needs_through(monkeypatch):
    monkeypatch.setattr(notices, "quiet", lambda now=None, p=None: True)
    notices.set_prefs({"events": {"ask": {"tg": "always"}, "done": {"tg": "always"}}})
    assert notices.telegram_ok("approve") is True
    assert notices.telegram_ok("done") is False
    notices.set_prefs({"quiet": {"needs": False}})
    assert notices.telegram_ok("approve") is False


# --- NEEDS YOU ----------------------------------------------------------------------

def test_needs_from_status_offers_and_login(monkeypatch):
    from bridge import rivendell
    monkeypatch.setattr(rivendell, "queue", lambda: {"prod": [
        {"key": "impl:r1", "request_id": "r1", "kind": "impl", "offered": True,
         "label": "Sentry critical", "slug": "o/r", "created_at": 100.0, "link": "https://rv/x"},
        {"key": "review:r2", "request_id": "r2", "kind": "review", "offered": False,
         "label": "PR #9", "slug": "o/r", "created_at": 101.0, "link": None}]})
    notices.emit("approve", "s1", body="Bash: rm -rf old", meta={"job_id": "j1"})
    notices.emit("login", "s3", body="Account 2")
    notices.emit("login", "s4", body="Account 2")
    notices.emit("resumed", "s4", body="Signed in")          # superseded: no longer needs you
    status = {"s1": {"state": "awaiting", "kind": "permission", "label": "Bash"},
              "s2": {"state": "awaiting", "kind": None, "label": "pick a name?"},
              "s5": {"state": "working", "kind": None, "label": None}}
    got = {n["subject"]: n for n in notices.needs(status)}
    assert set(got) == {"s1", "s2", "s3", "rv:prod:r1"}
    assert got["s1"]["kind"] == "approve" and got["s1"]["body"] == "Bash: rm -rf old"
    assert got["s1"]["meta"]["job_id"] == "j1" and got["s1"]["verb"] == "APPROVE"
    assert got["s2"]["kind"] == "asking" and got["s2"]["body"] == "pick a name?"
    assert got["s3"]["kind"] == "login" and got["s3"]["verb"] == "SIGN IN"
    rv = got["rv:prod:r1"]
    assert rv["kind"] == "rv_offer" and rv["session_id"] is None
    assert rv["meta"] == {"instance_id": "prod", "key": "impl:r1", "link": "https://rv/x", "job_kind": "impl"}


def test_needs_survives_rivendell_failure(monkeypatch):
    from bridge import rivendell

    def boom():
        raise RuntimeError("worker gone")
    monkeypatch.setattr(rivendell, "queue", boom)
    status = {"s1": {"state": "awaiting", "kind": "question", "label": "Which one?"}}
    assert [n["kind"] for n in notices.needs(status)] == ["question"]


# --- emitters: sessions, limits, logins, MOVE -----------------------------------

@pytest.fixture
def sent(monkeypatch):
    from bridge import runner
    box = []
    monkeypatch.setattr(runner, "send", lambda chat, text, kb=None, **k: box.append(text))
    notices.set_prefs({"events": {g: {"tg": "always"} for g in notices.DEFAULTS}})
    return box


def _sess(origin="dashboard"):
    s = store.create_session(555, "/repo", origin=origin)
    with closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=? WHERE id=?", ("Invoices", s["id"]))
    return s["id"]


def test_turn_error_emits_failed_with_outcome(monkeypatch, sent):
    from bridge import runner
    sid = _sess()
    monkeypatch.setattr(store, "last_turn", lambda s: {"status": "error", "elapsed": 760, "outcome": {
        "code": "context", "label": "OUT OF CONTEXT",
        "detail": "The conversation outgrew the window. Start a fresh session."}})
    runner.notify_turn_done(555, sid, True)
    row = notices.feed()[0]
    assert (row["kind"], row["subject"], row["title"]) == ("failed", sid, "Invoices")
    assert row["body"] == "Out of context: The conversation outgrew the window. Start a fresh session."
    assert row["meta"]["elapsed"] == 760
    assert sent and "hit an error" in sent[0]


def test_turn_done_emits_done_with_closing_line(monkeypatch, sent):
    from bridge import runner
    sid = _sess()
    monkeypatch.setattr(store, "last_turn", lambda s: {"status": "done", "elapsed": 252, "outcome": None})
    runner.notify_turn_done(555, sid, False, body="\n  All green — both shots attached.\nMore detail")
    row = notices.feed()[0]
    assert (row["kind"], row["body"], row["meta"]["elapsed"]) == ("done", "All green — both shots attached.", 252)


def test_plugin_session_turn_emits_nothing(monkeypatch, sent):
    from bridge import runner
    sid = _sess(origin="rivendell:prod")
    monkeypatch.setattr(store, "last_turn", lambda s: {"status": "done", "elapsed": 1, "outcome": None})
    runner.notify_turn_done(555, sid, False, body="step 3 done")
    runner.notify_needs_you(555, sid, "which branch?")
    assert notices.feed() == [] and sent == []


def test_awaiting_emits_approve_with_summary(sent):
    from bridge import runner
    sid = _sess()
    runner.notify_awaiting(555, sid, "permission", body="Bash: rm -rf old", job_id="j1")
    runner.notify_awaiting(555, sid, "question", body="Keep 344px?", job_id="j1")
    q, a = notices.feed()
    assert (a["kind"], a["body"], a["meta"]["job_id"]) == ("approve", "Bash: rm -rf old", "j1")
    assert (q["kind"], q["body"]) == ("question", "Keep 344px?")


def test_needs_you_emits_asking(sent):
    from bridge import runner
    sid = _sess()
    runner.notify_needs_you(555, sid, "Pick a name for the branch?")
    assert notices.feed()[0]["kind"] == "asking"
    assert notices.feed()[0]["body"] == "Pick a name for the branch?"


def test_tg_off_suppresses_send(monkeypatch, sent):
    from bridge import runner
    sid = _sess()
    monkeypatch.setattr(store, "last_turn", lambda s: {"status": "done", "elapsed": 1, "outcome": None})
    notices.set_prefs({"events": {"done": {"tg": "off"}}})
    runner.notify_turn_done(555, sid, False, body="ok")
    assert sent == [] and notices.feed()[0]["kind"] == "done"


def test_auth_stop_needs_you_and_sign_in_resumes(monkeypatch, sent):
    from bridge import runner
    sid = _sess()
    runner._auth_stop(555, sid, 2)
    assert [n["kind"] for n in notices.needs({})] == ["login"]
    notices.emit("resumed", sid, body="Signed in")
    assert notices.needs({}) == []


def test_move_finish_emits():
    from bridge import movejob
    j = movejob.Job("export", "→ ~/out.move")
    j.finish("done")
    k = movejob.Job("import", "← ~/in.move")
    k.finish("failed", "bad archive")
    c = movejob.Job("export", "→ ~/x.move")
    c.finish("cancelled")
    rows = notices.feed()
    assert [(r["kind"], r["title"], r["body"]) for r in rows] == [
        ("move_failed", "← ~/in.move", "bad archive"), ("move_done", "→ ~/out.move", "")]


def test_account_needs_outlive_their_own_failed_and_parked():
    notices.emit("login", "s1", body="Account 2")
    notices.emit("failed", "s1", body="Could not start")        # the same dead turn ending
    notices.emit("limit_choice", "s2", body="Switch or wait")
    notices.emit("parked", "s2", body="resumes 19:00")           # the park behind the card
    assert sorted(n["kind"] for n in notices.needs({})) == ["limit_choice", "login"]
    # Running again (a prompt sent by hand) answers it too.
    assert [n["kind"] for n in notices.needs({"s1": {"state": "working"}})] == ["limit_choice"]
