"""Unit tests for usage-limit deferred auto-resume (bridge/limits.py).
Run directly: `python tests/test_limits.py` (or with pytest). Env is set before
importing the package so config picks it up.
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


def _reset_limits():
    """Blank limits' module state (pending, timer, episode memory, file)."""
    with limits._lock:
        if limits._timer is not None:
            limits._timer.cancel()
        limits._timer = None
        limits._fire_at = None
        limits._pending.clear()
    limits._last_tries.clear()
    try:
        os.remove(limits._path())
    except OSError:
        pass


def _usage(percent=100, resets_at=None):
    """Patch usage.get_usage seen by limits; returns the restore closure."""
    saved = limits.usage.get_usage
    data = {"available": True,
            "five_hour": {"percent": percent, "resets_at": resets_at,
                          "severity": "normal"},
            "seven_day": None, "limits": []}
    limits.usage.get_usage = lambda: data
    return lambda: setattr(limits.usage, "get_usage", saved)


class _Rec:
    def __init__(self, job="JOB"):
        self.calls = []
        self._job = job

    def __call__(self, *a, **kw):
        self.calls.append((a, kw))
        return self._job


def test_is_limit_error_matches_real_shapes():
    yes = [
        "Claude AI usage limit reached|1751234567",
        "usage limit reached",
        "API Error: 429 usage limit reached — try again later",
        "You've hit your usage limit · resets 3pm",
        "You've reached your usage limit",
        "You've hit your weekly limit · resets Thu 09:00",
        "You've hit your session limit · resets 9:30pm",
        "You've hit your Opus limit · resets 6pm",
        "You've hit your Fable 5 limit · resets 6pm",
    ]
    no = [
        "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
        "You've hit your monthly spend limit.",
        "You're out of usage credits. /model to switch models.",
        "claude exited 1",
        "",
        None,
    ]
    for t in yes:
        assert limits.is_limit_error(t), f"should match: {t!r}"
    for t in no:
        assert not limits.is_limit_error(t), f"should NOT match: {t!r}"


def test_is_server_error_matches_real_shapes():
    yes = [
        "API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\"}}",
        "API Error: 502 Bad Gateway",
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary",
        "API Error: Server error mid-response. The response above may be incomplete.",
        "Internal server error",
        "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
    ]
    no = [
        "API Error: 429 usage limit reached — try again later",
        "You've hit your weekly limit · resets Thu 09:00",
        "API Error: 401 Invalid authentication credentials",
        "API Error: 400 Prompt is too long",
        "claude exited 1",
        "",
        None,
    ]
    for t in yes:
        assert limits.is_server_error(t), f"should match: {t!r}"
    for t in no:
        assert not limits.is_server_error(t), f"should NOT match: {t!r}"


def test_defer_server_walks_the_backoff_ladder():
    """First retry is instant, then 1/5/10/15/30 min; a 7th gives up, and a
    completed turn (note_ok) starts the next episode back at instant."""
    _reset_limits()
    run = _Rec()
    saved = config.ALLOWED_CHAT_IDS
    config.ALLOWED_CHAT_IDS = {CHAT}
    try:
        for i, wait in enumerate(limits.SERVER_BACKOFF, start=1):
            d = limits.defer_server("s-b", CHAT, "/tmp/b", model="opus")
            assert d is not None, f"attempt {i} should be allowed"
            when, attempt = d
            assert attempt == i
            assert abs(when - (time.time() + wait)) < 5, f"attempt {i} wait"
            assert limits._pending["s-b"]["kind"] == "server"
            limits._pending["s-b"]["at"] = time.time()   # skip the real wait
            limits._fire(run=run, notify=_Rec())         # resume → 500 again → re-defer
        assert len(run.calls) == len(limits.SERVER_BACKOFF)
        assert limits.defer_server("s-b", CHAT, "/tmp/b") is None   # ladder exhausted
        limits.note_ok("s-b")                            # a completed turn ends the episode
        assert limits.defer_server("s-b", CHAT, "/tmp/b")[1] == 1
    finally:
        config.ALLOWED_CHAT_IDS = saved
        _reset_limits()


def test_fire_resumes_only_due_entries_and_rearms():
    """A session still inside its backoff wait is left parked, and the timer is
    re-armed for it — one late 500 can't drag another session's retry forward."""
    _reset_limits()
    restore = _usage(percent=100, resets_at=time.time() - 10)   # limit already reset
    saved = config.ALLOWED_CHAT_IDS
    config.ALLOWED_CHAT_IDS = {CHAT}
    try:
        limits.defer_server("s-now", CHAT, None)                # attempt 1 → instant
        limits._last_tries["s-late"] = 1
        limits.defer_server("s-late", CHAT, None)               # attempt 2 → +60s
        run, notify = _Rec(), _Rec()
        limits._fire(run=run, notify=notify)
        assert [kw["session_id"] for _a, kw in run.calls] == ["s-now"]
        assert run.calls[0][0][1] == limits.SERVER_NUDGE        # server nudge, not limit
        assert notify.calls == []                               # announced at defer time
        assert list(limits._pending) == ["s-late"]
        assert limits._timer is not None
        assert abs(limits._fire_at - limits._pending["s-late"]["at"]) < 1
    finally:
        config.ALLOWED_CHAT_IDS = saved
        restore()
        _reset_limits()


def test_boot_keeps_backoff_due_time():
    _reset_limits()
    import json
    due = time.time() + 900
    with open(limits._path(), "w") as f:
        json.dump({"s-b6": {"chat_id": CHAT, "cwd": None, "model": None,
                            "effort": None, "tries": 4, "since": time.time(),
                            "at": due, "kind": "server"}}, f)
    restore = _usage(percent=42, resets_at=None)
    try:
        limits.boot()
        assert abs(limits._pending["s-b6"]["at"] - due) < 1     # not pulled forward
        assert abs(limits._fire_at - due) < 1
    finally:
        restore()
        _reset_limits()


def test_defer_uses_reset_time_and_persists():
    _reset_limits()
    restore = _usage(percent=100, resets_at=time.time() + 3600)
    try:
        d = limits.defer("s-1", CHAT, "/tmp/proj", model="opus", effort="high")
        assert d is not None
        when, first = d
        assert first is True
        assert abs(when - (time.time() + 3600 + limits.RESET_BUFFER)) < 5
        assert limits._fire_at == when and limits._timer is not None
        import json
        with open(limits._path()) as f:
            data = json.load(f)
        assert data["s-1"]["chat_id"] == CHAT and data["s-1"]["cwd"] == "/tmp/proj"
        assert data["s-1"]["model"] == "opus" and data["s-1"]["tries"] == 1
    finally:
        restore()
        _reset_limits()


def test_defer_unknown_reset_falls_back_to_probe():
    _reset_limits()
    restore = _usage(percent=42, resets_at=None)   # nothing reads exhausted
    try:
        when, _first = limits.defer("s-2", CHAT, None)
        assert abs(when - (time.time() + limits.RETRY_UNKNOWN)) < 5
    finally:
        restore()
        _reset_limits()


def test_fire_resumes_pending_and_clears():
    _reset_limits()
    restore = _usage(percent=100, resets_at=time.time() + 3600)
    try:
        limits.defer("s-3", CHAT, "/tmp/rez", model="sonnet")
        run, notify = _Rec(), _Rec()
        saved = config.ALLOWED_CHAT_IDS
        config.ALLOWED_CHAT_IDS = {CHAT}
        try:
            limits._fire(run=run, notify=notify)
        finally:
            config.ALLOWED_CHAT_IDS = saved
        assert len(run.calls) == 1
        a, kw = run.calls[0]
        assert a[0] == CHAT and a[1] == limits.NUDGE and a[2] == []
        assert kw == {"project": "/tmp/rez", "session_id": "s-3",
                      "model": "sonnet", "effort": None}
        assert len(notify.calls) == 1                 # first attempt pings
        assert limits._pending == {} and limits._timer is None
        assert limits._last_tries.get("s-3") == 1     # episode memory survives the fire
    finally:
        restore()
        _reset_limits()


def test_redefer_counts_tries_and_gives_up():
    _reset_limits()
    restore = _usage(percent=100, resets_at=time.time() + 60)
    run = _Rec()
    saved = config.ALLOWED_CHAT_IDS
    config.ALLOWED_CHAT_IDS = {CHAT}
    try:
        for i in range(1, limits.MAX_TRIES + 1):
            d = limits.defer("s-4", CHAT, None)
            assert d is not None
            assert d[1] == (i == 1)                   # only the first defer is 'first'
            limits._fire(run=run, notify=_Rec())      # still limited → re-defer next loop
        assert limits.defer("s-4", CHAT, None) is None  # exhausted
        limits.note_ok("s-4")                          # a completed turn resets the episode
        assert limits.defer("s-4", CHAT, None)[1] is True
    finally:
        config.ALLOWED_CHAT_IDS = saved
        restore()
        _reset_limits()


def test_fire_resumes_dashboard_session_without_telegram():
    """A dashboard-only install has no ALLOWED_CHAT_IDS, so its sessions are owned
    by DASH_CHAT_ID (0 by default). _fire pops entries before the owner check, so
    gating on ALLOWED_CHAT_IDS alone didn't skip them — it silently DISCARDED
    them, and the headline resume-at-reset feature never fired at all."""
    _reset_limits()
    restore = _usage(percent=100, resets_at=time.time() + 3600)
    saved_allowed, saved_dash = config.ALLOWED_CHAT_IDS, config.DASH_CHAT_ID
    config.ALLOWED_CHAT_IDS, config.DASH_CHAT_ID = set(), 0
    try:
        limits.defer("s-dash", config.DASH_CHAT_ID, "/tmp/rez", model="opus")
        run, notify = _Rec(), _Rec()
        limits._fire(run=run, notify=notify)
        assert len(run.calls) == 1, "dashboard session was dropped, not resumed"
        assert run.calls[0][0][0] == config.DASH_CHAT_ID
        assert limits._pending == {}
    finally:
        config.ALLOWED_CHAT_IDS, config.DASH_CHAT_ID = saved_allowed, saved_dash
        restore()
        _reset_limits()


def test_fire_still_skips_unauthorized_owner():
    """The gate has to keep doing its job: a chat id that is neither an allowed
    Telegram user nor the dashboard owner must not have turns resumed for it."""
    _reset_limits()
    restore = _usage(percent=100, resets_at=time.time() + 3600)
    saved_allowed, saved_dash = config.ALLOWED_CHAT_IDS, config.DASH_CHAT_ID
    config.ALLOWED_CHAT_IDS, config.DASH_CHAT_ID = {CHAT}, CHAT
    try:
        limits.defer("s-evil", 999999, None)
        run = _Rec()
        limits._fire(run=run, notify=_Rec())
        assert run.calls == []
    finally:
        config.ALLOWED_CHAT_IDS, config.DASH_CHAT_ID = saved_allowed, saved_dash
        restore()
        _reset_limits()


def test_fire_skips_busy_session_silently():
    _reset_limits()
    restore = _usage(percent=100, resets_at=time.time() + 60)
    try:
        limits.defer("s-5", CHAT, None)
        run, notify = _Rec(job=None), _Rec()          # run slot busy → job None
        saved = config.ALLOWED_CHAT_IDS
        config.ALLOWED_CHAT_IDS = {CHAT}
        try:
            limits._fire(run=run, notify=notify)
        finally:
            config.ALLOWED_CHAT_IDS = saved
        assert len(run.calls) == 1 and notify.calls == []
        assert "s-5" not in limits._last_tries        # episode closed — user moved on
    finally:
        restore()
        _reset_limits()


def test_boot_rearms_persisted_pending():
    _reset_limits()
    import json
    with open(limits._path(), "w") as f:
        json.dump({"s-6": {"chat_id": CHAT, "cwd": None, "model": None,
                           "effort": None, "tries": 1, "since": time.time()}}, f)
    restore = _usage(percent=42, resets_at=None)      # limit already reset
    try:
        limits.boot()
        assert "s-6" in limits._pending
        assert limits._timer is not None
        assert limits._fire_at <= time.time() + 61    # fires shortly
    finally:
        restore()
        _reset_limits()


def test_runner_defers_limit_killed_streaming_turn():
    """The integration hook: an error job whose text is a limit message gets
    parked via limits.defer instead of the immediate crash-resume."""
    s = store.create_session(CHAT, "lim", cwd="/tmp/lim")
    store.set_claude_session_id(s["id"], "c-lim")
    job = runner.Job("j-lim", CHAT, s["id"])
    job.status = "error"
    job.result = "You've hit your usage limit · resets 3pm"

    deferred, notes = [], []
    saved_defer, saved_notify = limits.defer, runner._notify
    saved_auto = config.AUTO_RESUME
    limits.defer = lambda *a, **kw: deferred.append((a, kw)) or (time.time() + 60, True)
    runner._notify = lambda chat, text: notes.append(text)
    config.AUTO_RESUME = True
    try:
        assert runner._maybe_auto_resume(job, "/tmp/lim", "opus", None) is True
        assert deferred == [((s["id"], CHAT, "/tmp/lim", "opus", None), {})]
        assert len(notes) == 1 and "usage limit" in notes[0]
        assert runner._resume_fails.get(s["id"]) is None   # cap untouched
    finally:
        limits.defer, runner._notify = saved_defer, saved_notify
        config.AUTO_RESUME = saved_auto


def test_runner_stderr_limit_death_also_defers():
    """No result event (CLI died printing to stderr): error_msg carries the text."""
    s = store.create_session(CHAT, "lim2", cwd="/tmp/lim2")
    store.set_claude_session_id(s["id"], "c-lim2")
    job = runner.Job("j-lim2", CHAT, s["id"])
    job.status = "error"
    job.error_msg = "Claude AI usage limit reached|1751234567"

    deferred = []
    saved_defer, saved_notify = limits.defer, runner._notify
    saved_auto = config.AUTO_RESUME
    limits.defer = lambda *a, **kw: deferred.append(a) or (time.time() + 60, False)
    runner._notify = lambda chat, text: None
    config.AUTO_RESUME = True
    try:
        assert runner._maybe_auto_resume(job, "/tmp/lim2", None, None) is True
        assert len(deferred) == 1
    finally:
        limits.defer, runner._notify = saved_defer, saved_notify
        config.AUTO_RESUME = saved_auto


def test_runner_backs_off_server_error_turn():
    """A 500-killed turn goes on the backoff ladder, not the instant crash-resume."""
    s = store.create_session(CHAT, "srv", cwd="/tmp/srv")
    store.set_claude_session_id(s["id"], "c-srv")
    job = runner.Job("j-srv", CHAT, s["id"])
    job.status = "error"
    job.result = "API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\"}}"

    deferred, notes = [], []
    saved_defer, saved_notify = limits.defer_server, runner._notify
    saved_auto = config.AUTO_RESUME
    limits.defer_server = lambda *a, **kw: (deferred.append((a, kw))
                                            or (time.time() + 300, 3))
    runner._notify = lambda chat, text: notes.append(text)
    config.AUTO_RESUME = True
    try:
        assert runner._maybe_auto_resume(job, "/tmp/srv", "opus", None) is True
        assert deferred == [((s["id"], CHAT, "/tmp/srv", "opus", None), {})]
        assert len(notes) == 1 and "in 5 min" in notes[0] and "attempt 3/6" in notes[0]
        assert runner._resume_fails.get(s["id"]) is None   # crash cap untouched
    finally:
        limits.defer_server, runner._notify = saved_defer, saved_notify
        config.AUTO_RESUME = saved_auto


def test_runner_gives_up_after_backoff_ladder():
    """Ladder exhausted → no resume, so the caller reports the error normally."""
    s = store.create_session(CHAT, "srv2", cwd="/tmp/srv2")
    store.set_claude_session_id(s["id"], "c-srv2")
    job = runner.Job("j-srv2", CHAT, s["id"])
    job.status = "error"
    job.error_msg = "API Error: 529 Overloaded"

    saved_defer, saved_notify = limits.defer_server, runner._notify
    saved_auto = config.AUTO_RESUME
    limits.defer_server = lambda *a, **kw: None
    runner._notify = lambda chat, text: None
    config.AUTO_RESUME = True
    try:
        assert runner._maybe_auto_resume(job, "/tmp/srv2", None, None) is False
    finally:
        limits.defer_server, runner._notify = saved_defer, saved_notify
        config.AUTO_RESUME = saved_auto


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
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
