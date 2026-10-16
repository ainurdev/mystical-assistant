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
    from bridge import rivendell, runner
    monkeypatch.setattr(runner, "_auth_dead", {2: {"sid": "s3"}})
    monkeypatch.setattr(rivendell, "queue", lambda: {"prod": [
        {"key": "impl:r1", "request_id": "r1", "kind": "impl", "offered": True,
         "label": "Sentry critical", "slug": "o/r", "created_at": 100.0, "link": "https://rv/x"},
        {"key": "review:r2", "request_id": "r2", "kind": "review", "offered": False,
         "label": "PR #9", "slug": "o/r", "created_at": 101.0, "link": None}]})
    notices.emit("approve", "s1", body="Bash: rm -rf old", meta={"job_id": "j1"})
    notices.emit("login", "s3", body="Account 2", meta={"slot": 2})
    notices.emit("login", "s4", body="Account 2", meta={"slot": 2})
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
    assert rv["meta"] == {"instance_id": "prod", "instance": "prod", "key": "impl:r1",
                          "link": "https://rv/x", "job_kind": "impl"}


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
    runner.notify_awaiting(555, sid, "permission", body="Bash: rm -rf old", job_id="j1", request_id="r1")
    runner.notify_awaiting(555, sid, "question", body="Keep 344px?", job_id="j1", request_id="r2")
    q, a = notices.feed()
    assert (a["kind"], a["body"], a["meta"]) == ("approve", "Bash: rm -rf old", {"job_id": "j1", "request_id": "r1", "project": "/repo", "session_id": sid})
    assert q["meta"]["request_id"] == "r2"
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
    runner._auth_dead.pop(2, None)                      # signed in (resume_after_login pops it)
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


def test_account_needs_outlive_their_own_failed_and_parked(monkeypatch):
    from bridge import runner
    monkeypatch.setattr(runner, "_auth_dead", {2: {"sid": "s1"}})
    notices.emit("login", "s1", body="Account 2", meta={"slot": 2})
    notices.emit("failed", "s1", body="Could not start")        # the same dead turn ending
    notices.emit("limit_choice", "s2", body="Switch or wait")
    notices.emit("parked", "s2", body="resumes 19:00")           # the park behind the card
    parked = {"s2": {"state": "parked", "kind": "limit"}}
    assert sorted(n["kind"] for n in notices.needs(parked)) == ["limit_choice", "login"]
    # Running again (a prompt sent by hand) answers it too.
    assert [n["kind"] for n in notices.needs({**parked, "s1": {"state": "working"}})] == ["limit_choice"]


# --- emitters: Rivendell and PRs ------------------------------------------------

def _rv(monkeypatch):
    from bridge import rivendell
    monkeypatch.setattr(rivendell.Worker, "_ack", lambda self, key, state: None)
    w = rivendell.Worker({"id": "prod", "name": "production", "enable": True,
                          "api_url": "http://api.example:3001", "token": "rvd_t", "ws_url": "",
                          "model": "opus", "workdir": "", "review_timeout": 3600,
                          "impl_timeout": 10800})
    monkeypatch.setattr(w, "_deliver_telegram", lambda text, kb: None)
    return w


def test_rivendell_offer_emits_rv_offer(monkeypatch):
    w = _rv(monkeypatch)
    w._enqueue("impl", "r1", "acme/app", offered=True)
    w._notify_queued("impl:r1")
    row = notices.feed()[0]
    assert (row["kind"], row["subject"], row["title"]) == ("rv_offer", "rv:prod:r1", "acme/app")
    assert row["meta"]["key"] == "impl:r1" and row["meta"]["instance_id"] == "prod"
    assert row["meta"]["job_kind"] == "impl" and "teammate" in row["body"]


def test_rivendell_held_accept_and_reject(monkeypatch):
    w = _rv(monkeypatch)
    monkeypatch.setattr(w, "_run_accepted", lambda item: None)
    monkeypatch.setattr(w, "_do_reject", lambda item: None)
    w._enqueue("review", "r2", "acme/app")
    w._notify_queued("review:r2")
    w.accept("review:r2")
    w._enqueue("review", "r3", "acme/app")
    w.reject("review:r3")
    assert [(r["kind"], r["subject"]) for r in notices.feed()] == [
        ("rv_dismissed", "rv:prod:r3"), ("rv_started", "rv:prod:r2"), ("rv_held", "rv:prod:r2")]


def test_rivendell_link_break_and_back(monkeypatch):
    w = _rv(monkeypatch)
    w.status, w.status_detail, w.down_since = "auth_error", "4401", time.time() - 60
    w._alert_broken()
    w.alert_at = time.time()
    w._recovered()
    w._recovered()                           # proving itself again is not a second "back"
    rows = notices.feed()
    assert [(r["kind"], r["subject"]) for r in rows] == [
        ("rv_link_back", "rv-link:prod"), ("rv_link", "rv-link:prod")]
    assert rows[1]["title"] == "production" and "refused this bridge's token" in rows[1]["body"]


def test_rivendell_done_without_session_still_emits(monkeypatch):
    w = _rv(monkeypatch)
    w._ping_done("abcdef123456", False, "prompt fetch failed: 500\ntrace", kind_path="implementation-requests")
    row = notices.feed()[0]
    assert (row["kind"], row["subject"]) == ("rv_failed", "rv:prod:abcdef123456")
    assert (row["title"], row["body"]) == ("Rivendell job abcdef12", "prompt fetch failed: 500")


def test_rivendell_done_with_session_carries_pr(monkeypatch):
    from bridge import rivendell
    w = _rv(monkeypatch)
    s = store.create_session(555, "/repo", origin="rivendell:prod")
    with closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=?, ref=? WHERE id=?", ("Review PR #212", "prod:r9", s["id"]))
    monkeypatch.setattr(rivendell, "_result_view", lambda sid, checks=True: {
        "pr": {"number": 212, "url": "https://gh/pr/212"}, "wall_s": 420})
    w._ping_done("r9", True, "Approved with 2 comments.\nDetails…", kind_path="review-requests")
    row = notices.feed()[0]
    assert (row["kind"], row["verb"], row["title"], row["body"]) == (
        "rv_done", "REVIEWED", "Review PR #212", "Approved with 2 comments.")
    assert row["meta"]["pr_url"] == "https://gh/pr/212" and row["meta"]["session_id"] == s["id"]


def test_rivendell_question_emits_for_its_session(monkeypatch):
    from bridge import rivendell
    s = store.create_session(555, "/repo", origin="rivendell:prod")
    monkeypatch.setattr(rivendell, "_send_question", lambda *a: None)

    class Job:
        id, store_session_id, started = "j7", s["id"], time.time()
    assert rivendell.ping_question(Job, "req1", [{"question": "Ship it?", "options": []}]) is True
    row = notices.feed()[0]
    assert (row["kind"], row["subject"], row["body"], row["meta"]["job_id"], row["meta"]["request_id"]) == (
        "question", s["id"], "Ship it?", "j7", "req1")


def test_pr_fresh_ping_emits(monkeypatch):
    from bridge import prstatus
    monkeypatch.setattr(prstatus, "_spawn", lambda fn, *a: None)
    store.set_setting("pr_pinged:o/r:feat/x", None)
    pr = {"state": "OPEN", "sha": "abc", "number": 208, "title": "Device runs", "head": "feat/x",
          "url": "https://gh/pr/208", "review": None, "failed": 2, "running": 0,
          "checks": [{"name": "e2e", "state": "fail"}, {"name": "lint", "state": "fail"},
                     {"name": "unit", "state": "pass"}]}
    prstatus._pings("/repo", "o/r", "feat/x", pr, "s1")
    prstatus._pings("/repo", "o/r", "feat/x", pr, "s1")       # the same red commit: once
    rows = notices.feed()
    assert [(r["kind"], r["subject"], r["title"], r["body"]) for r in rows] == [
        ("pr_failing", "pr:o/r:feat/x", "#208 · Device runs", "2 of 3 failed: e2e, lint")]
    assert rows[0]["meta"] == {"url": "https://gh/pr/208", "number": 208}


def test_needs_carry_project_and_instance_name(monkeypatch):
    from bridge import rivendell, rivendell_instances
    sid = _sess()
    monkeypatch.setattr(rivendell, "queue", lambda: {"prod": [
        {"key": "impl:r1", "request_id": "r1", "kind": "impl", "offered": True, "label": "x",
         "slug": "o/r", "created_at": 1.0, "link": None}]})
    monkeypatch.setattr(rivendell_instances, "instances", lambda: [{"id": "prod", "name": "production"}])
    got = {n["kind"]: n for n in notices.needs({sid: {"state": "awaiting", "kind": "permission", "label": "Bash"}})}
    assert got["approve"]["title"] == "Invoices" and got["approve"]["meta"]["project"] == "/repo"
    assert got["rv_offer"]["meta"]["instance"] == "production"



# --- review fixes: needs that answer themselves, the weekly report, limits ------

def test_sign_in_clears_every_login_need_on_that_slot(monkeypatch, sent):
    from bridge import runner
    monkeypatch.setattr(runner, "_auth_dead", {})
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **k: object())
    monkeypatch.setattr(config, "AUTO_RESUME", True)
    a, b = _sess(), _sess()
    for sid in (a, b):
        store.set_claude_session_id(sid, "c-" + sid)
        runner._auth_stop(555, sid, 2)          # one dead login, two stopped sessions
    assert sorted(n["subject"] for n in notices.needs({})) == sorted([a, b])
    assert runner.resume_after_login(2) is True  # resumes b, the one it kept
    assert notices.needs({}) == []               # a's SIGN IN went with the slot's


def test_login_need_from_a_telegram_reply_carries_its_slot(monkeypatch, sent):
    from bridge import runner
    monkeypatch.setattr(runner, "_auth_dead", {})
    sid = _sess()
    runner._auth_stop(555, sid, 2, reply=True)
    assert (notices.feed()[0]["kind"], notices.feed()[0]["meta"]["slot"]) == ("login", 2)
    assert notices.needs({})[0]["meta"]["slot"] == 2


def test_wait_answers_the_limit_card():
    notices.emit("limit_choice", "s1", body="Usage limit reached.", meta={"rungs": [{"slot": 2, "label": "account 2"}]})
    notices.emit("parked", "s1", body="resumes ~19:00")
    st = {"s1": {"state": "parked", "kind": "limit", "label": "usage limit"}}
    assert [n["kind"] for n in notices.needs(st)] == ["limit_choice"]
    notices.emit("waiting", "s1", body="You chose to wait for the usage limit to reset.")
    assert notices.needs(st) == []
    assert notices.feed()[0]["verb"] == "WAITING"


def test_limit_need_ends_when_the_session_is_no_longer_parked():
    notices.emit("limit_choice", "s1", body="Usage limit reached.")
    assert notices.needs({}) == []
    assert notices.needs({"s1": {"state": "working"}}) == []


def test_telegram_wait_tap_writes_waiting(monkeypatch):
    from bridge import dispatch
    sid = _sess()
    monkeypatch.setattr(dispatch, "answer_cb", lambda *a, **k: None)
    monkeypatch.setattr(dispatch, "edit", lambda *a, **k: None)
    dispatch._fallback_callback({"id": "cb1"}, 555, 7, f"fb:w:{sid}")
    assert (notices.feed()[0]["kind"], notices.feed()[0]["subject"]) == ("waiting", sid)


def test_weekly_waits_out_quiet_hours(monkeypatch):
    from bridge import report
    import bridge.telegram as tg
    sent = []
    monkeypatch.setattr(tg, "send", lambda chat, text, *a, **k: sent.append(text))
    monkeypatch.setattr(report, "render", lambda w: "the report")
    monkeypatch.setattr(report, "weekly", lambda chat, back=1: {})
    monkeypatch.setattr(report, "pending_week", lambda now, last: None if last else 1_700_000_000.0)
    store.set_setting(report._SENT_KEY, None)
    monkeypatch.setattr(notices, "quiet", lambda now=None, p=None: True)
    report._push_due()
    assert sent == [] and store.get_setting(report._SENT_KEY) is None   # held, not dropped
    monkeypatch.setattr(notices, "quiet", lambda now=None, p=None: False)
    report._push_due()
    assert sent == ["the report"] and store.get_setting(report._SENT_KEY) == str(1_700_000_000.0)
    assert [r["kind"] for r in notices.feed()] == ["weekly"]


def test_weekly_with_its_route_off_is_marked_without_sending(monkeypatch):
    from bridge import report
    import bridge.telegram as tg
    sent = []
    monkeypatch.setattr(tg, "send", lambda chat, text, *a, **k: sent.append(text))
    monkeypatch.setattr(report, "pending_week", lambda now, last: None if last else 1_700_000_000.0)
    store.set_setting(report._SENT_KEY, None)
    notices.set_prefs({"events": {"weekly": {"tg": "off"}}})
    report._push_due()
    assert sent == [] and store.get_setting(report._SENT_KEY) == str(1_700_000_000.0)
    assert "ready" in notices.feed()[0]["body"]


def test_limit_reset_row_is_written_with_telegram_off(monkeypatch):
    from bridge import limits
    monkeypatch.setattr(config, "NOTIFY_ENABLE", False)
    monkeypatch.setattr(limits, "_save_locked", lambda: None)
    monkeypatch.setattr(limits, "_arm_locked", lambda at: None)
    monkeypatch.setattr(limits, "_pending", {"s9": {"chat_id": 555, "kind": "limit", "at": 0, "tries": 1}})
    pinged = []
    limits._fire(run=lambda *a, **k: object(), notify=lambda *a, **k: pinged.append(a))
    assert [(r["kind"], r["subject"]) for r in notices.feed()] == [("resumed", "s9")]
    assert pinged == []
