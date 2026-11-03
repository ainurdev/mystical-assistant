"""Claude Code's own signals in the runner: session state, background tasks,
API retries and rate-limit events (rows 1 and 2 of the Tools-and-platforms
report). The event dicts are shaped like the ones CLI 2.1.316 sent in the live
check (.mystical/cli-signals-check/clisig-bg.jsonl).
Run: `python tests/test_cli_signals.py`
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config, limits, runner, store  # noqa: E402

store.init()
CHAT = 555


def _job(sid="s-bg"):
    runner._jobs.clear()
    job = runner.Job("j-" + sid, CHAT, None)   # no store row: nothing journals
    job.store_session_id = None
    runner._jobs[job.id] = job
    return job


def _status(job, sid):
    job.store_session_id = sid
    return runner._build_status(bridge_running=[sid], awaiting=[], jobs=[],
                                external=[], native_snap={})[sid]


def _bg(*tasks):
    return {"type": "system", "subtype": "background_tasks_changed",
            "tasks": [{"task_id": t, "run_id": "r", "task_type": "local_bash",
                       "description": f"task {t}"} for t in tasks]}


def _state(s):
    return {"type": "system", "subtype": "session_state_changed", "state": s}


RESULT = {"type": "result", "subtype": "success", "result": "started", "num_turns": 2,
          "is_error": False, "total_cost_usd": 0.01}


def test_answered_with_background_tasks_is_background_not_working():
    job = _job()
    for d in (_state("running"), _bg("a"), RESULT, _state("idle"), _bg("a", "b")):
        runner._handle_event(job, d)
    st = _status(job, "s-bg")
    assert st["state"] == "background"
    assert [t["id"] for t in st["bg"]] == ["a", "b"] and st["bg"][0]["type"] == "shell"
    assert st["peak"] == 2 and st["since"] == job.answered_at
    runner._jobs.clear()


def test_the_set_is_replaced_not_paired_and_an_empty_one_ends_background():
    job = _job()
    for d in (RESULT, _state("idle"), _bg("a", "b"), _bg("b")):
        runner._handle_event(job, d)
    assert list(job.bg) == ["b"] and job.bg_peak == 2
    runner._handle_event(job, _bg())
    assert _status(job, "s-bg")["state"] == "working"   # process still closing
    runner._jobs.clear()


def test_a_follow_up_turn_for_a_finished_task_reads_working_again():
    job = _job()
    for d in (RESULT, _state("idle"), _bg("a"), _bg(), _state("running")):
        runner._handle_event(job, d)
    assert _status(job, "s-bg")["state"] == "working"
    runner._jobs.clear()


def test_a_cli_that_never_reports_its_state_keeps_todays_status():
    job = _job()
    for d in (RESULT, _bg("a")):
        runner._handle_event(job, d)
    assert job.cli_state is None
    assert _status(job, "s-bg")["state"] == "working"
    runner._jobs.clear()


def test_api_retry_is_journaled_and_rides_the_working_status():
    job = _job()
    runner._handle_event(job, {"type": "system", "subtype": "api_retry", "attempt": 3,
                               "max_retries": 10, "retry_delay_ms": 24000,
                               "error_status": 529, "error": "overloaded"})
    assert job.events[-1] == {"type": "retry", "attempt": 3, "max": 10,
                              "delay_ms": 24000, "error": "overloaded"}
    st = _status(job, "s-r")
    assert st["state"] == "working" and st["retry"]["attempt"] == 3 and st["retry"]["max"] == 10
    runner._handle_event(job, {"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}})
    assert job.retry is None and "retry" not in _status(job, "s-r")
    runner._jobs.clear()


def test_retry_reason_falls_back_to_the_status_or_connection():
    assert runner._retry_reason({"error_status": 503}) == "http_503"
    assert runner._retry_reason({}) == "connection"


def test_rate_limit_event_feeds_the_meter_and_journals_only_a_refusal():
    job = _job()
    seen = []
    saved = runner.accounts.note_rate_limit
    runner.accounts.note_rate_limit = lambda slot, info: seen.append((slot, info["status"]))
    try:
        ok = {"status": "allowed", "unifiedWindows": {"seven_day": {"utilization": 0.67}}}
        runner._handle_event(job, {"type": "rate_limit_event", "rate_limit_info": ok})
        assert seen == [(None, "allowed")] and not job.events
        no = {"status": "rejected", "resetsAt": 1793793600, "errorCode": "credits_required",
              "canUserPurchaseCredits": True}
        runner._handle_event(job, {"type": "rate_limit_event", "rate_limit_info": no})
        assert job.events[-1] == {"type": "ratelimit", "status": "rejected",
                                  "error_code": "credits_required", "resets_at": 1793793600, "buy": True}
    finally:
        runner.accounts.note_rate_limit = saved
        runner._jobs.clear()


def test_credits_required_is_not_parked_and_needs_you():
    s = store.create_session(CHAT, "cr", cwd="/tmp/cr")
    store.set_claude_session_id(s["id"], "c-cr")
    job = runner.Job("j-cr", CHAT, s["id"])
    job.status, job.result = "error", "API Error: 429 usage limit"
    job.rate_limit = {"status": "rejected", "errorCode": "credits_required",
                      "canUserPurchaseCredits": False}
    deferred, notes = [], []
    saved_defer, saved_notify, saved_auto = limits.defer, runner._notify, config.AUTO_RESUME
    limits.defer = lambda *a, **kw: deferred.append(a) or (time.time() + 60, True)
    runner._notify = lambda chat, text, kb=None, **kw: notes.append(kw.get("kind"))
    config.AUTO_RESUME = True
    try:
        assert runner._maybe_auto_resume(job, "/tmp/cr", None, None) is False
        assert deferred == [] and notes == ["credits"]
        st = runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                  external=[], native_snap={})[s["id"]]
        assert st["state"] == "credits" and st["buy"] is False
        assert limits.clear_credits(s["id"]) is True
        assert s["id"] not in limits.credits_blocked()
    finally:
        limits.defer, runner._notify, config.AUTO_RESUME = saved_defer, saved_notify, saved_auto
        limits.clear_credits(s["id"])


def test_the_text_alone_also_names_a_credits_death():
    assert limits.is_credits_error("API Error: Usage credits required for 1M context · run /model")
    assert not limits.is_credits_error("You've hit your usage limit · resets 3pm")


def test_a_rejected_events_reset_is_the_parks_time():
    s = store.create_session(CHAT, "rs", cwd="/tmp/rs")
    store.set_claude_session_id(s["id"], "c-rs")
    job = runner.Job("j-rs", CHAT, s["id"])
    job.status, job.result = "error", "You've hit your usage limit · resets 3pm"
    job.rate_limit = {"status": "rejected", "resetsAt": 1793793600}
    got = []
    saved_defer, saved_notify, saved_auto = limits.defer, runner._notify, config.AUTO_RESUME
    saved_escalate = runner.ladder.escalate
    limits.defer = lambda *a, **kw: got.append(kw.get("reset_at")) or (time.time() + 60, False)
    runner._notify = lambda *a, **kw: None
    runner.ladder.escalate = lambda *a, **kw: False
    config.AUTO_RESUME = True
    try:
        assert runner._maybe_auto_resume(job, "/tmp/rs", None, None) is True
        assert got == [1793793600.0]
    finally:
        limits.defer, runner._notify, config.AUTO_RESUME = saved_defer, saved_notify, saved_auto
        runner.ladder.escalate = saved_escalate


def test_defer_takes_a_future_reset_over_the_meter():
    limits._pending.clear()
    saved = limits._reset_epoch
    limits._reset_epoch = lambda now, slot=None: (_ for _ in ()).throw(AssertionError("read the meter"))
    try:
        at, first = limits.defer("s-x", CHAT, "/tmp/x", reset_at=time.time() + 3600)
        assert first and at > time.time() + 3600   # plus the reset buffer
    finally:
        limits._reset_epoch = saved
        limits.cancel("s-x")


def test_every_run_opts_in_to_session_state_events():
    assert runner._run_env(None)["CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"] == "1"


def test_only_a_recovery_run_asks_the_cli_to_carry_a_cut_turn_on():
    assert "CLAUDE_CODE_RESUME_INTERRUPTED_TURN" not in runner._run_env(None)
    assert runner._run_env(None, None, resume_cut=True)["CLAUDE_CODE_RESUME_INTERRUPTED_TURN"] == "1"


def _resuming():
    job = _job("s-rs")
    job.native_resume, job.resume_state = True, "waiting"
    return job


def test_a_native_resume_that_starts_is_accepted():
    job = _resuming()
    runner._handle_event(job, {"type": "command_lifecycle", "command_uuid": "c", "state": "started"})
    assert job.resume_state == "accepted"
    runner._handle_event(job, _state("idle"))          # its own idle at the end is no decline
    assert job.resume_state == "accepted" and not [e for e in job.events if e.get("type") == "resume"]
    runner._jobs.clear()


def test_a_native_resume_that_goes_idle_first_was_declined():
    job = _resuming()
    for d in (_state("running"), {"type": "system", "subtype": "init"}, _state("idle")):
        runner._handle_event(job, d)
    assert job.resume_state == "declined"
    assert job.events[-1] == {"type": "resume", "declined": True}
    runner._resume_declined(job)                         # the timer firing late adds nothing
    assert [e["type"] for e in job.events].count("resume") == 1
    runner._jobs.clear()


def test_a_declined_resume_is_announced_as_still_waiting_not_done():
    job = _resuming()
    job.store_session_id, job.status = "s-rs", "done"
    runner._resume_declined(job)
    said = []
    saved = runner.notify_turn_done
    runner.notify_turn_done = lambda chat, sid, is_error, body="": said.append((is_error, body))
    try:
        runner._announce_end(job)
    finally:
        runner.notify_turn_done = saved
        runner._jobs.clear()
    assert said and said[0][0] is True and "didn't carry it on" in said[0][1]


def test_resume_reason_on_a_reply_also_counts_as_started():
    job = _resuming()
    runner._handle_event(job, {"type": "result", "subtype": "success", "result": "DONE",
                               "num_turns": 1, "resume_reason": "interrupted_turn"})
    assert job.resume_state == "accepted"
    runner._jobs.clear()


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
