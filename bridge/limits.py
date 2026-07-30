"""Deferred auto-resume for turns the API killed — two waits, one parking lot.

The runner's immediate crash auto-resume is right for a Claude that died
locally, but wrong for both API-side deaths, so it defers the session here:

  - Usage limit (5-hour / weekly / per-model window): resuming before the
    window resets can only fail again, so the wait is the reset time read
    from the OAuth usage endpoint (bridge/usage.py).
  - Transient server error (500/529/"Server error mid-response", and the
    server-side 429 that isn't a usage limit): a retry can plausibly work,
    so the first one is immediate and each repeat waits longer
    (SERVER_BACKOFF: 1m → 30m) instead of hammering the API and stuffing
    the session transcript with dead turns.

Deferred sessions are remembered (persisted next to the DB as
limit_resume.json, so a bridge restart during the wait loses nothing) and one
timer is armed for the earliest due entry; when it fires, every session whose
wait is up resumes with a nudge. A resume that dies the same way lands right
back here — self-healing, capped per session at MAX_TRIES for a limit and at
the length of SERVER_BACKOFF for a server error.
"""

import json
import os
import re
import sys
import threading
import time

from bridge import config, usage

RESET_BUFFER = 90.0     # fire a bit after the advertised reset
RETRY_UNKNOWN = 1800.0  # reset time unknown (stale/absent usage data): probe again
MAX_TRIES = 12          # consecutive limit-deferred resumes per session before giving up

# Waits before the 1st…6th retry of a server-error turn; running out = give up.
SERVER_BACKOFF = (0.0, 60.0, 300.0, 600.0, 900.0, 1800.0)

NUDGE = (
    "⏮ Your previous turn was cut off because the Claude usage limit was "
    "reached — not by the user. The limit has reset. Review your recent "
    "transcript and continue exactly where you left off; finish the task "
    "you were doing. Don't start over.")

SERVER_NUDGE = (
    "⏮ Your previous turn was cut off by a transient Claude API error — not "
    "by the user. Review your recent transcript and continue exactly where "
    "you left off; finish the task you were doing. Don't start over.")

# Turn-death texts that mean "account usage window exhausted": the API/CLI's
# "usage limit reached" (old CLIs appended "|<epoch>") and the newer
# "You've hit your <session|weekly|Opus|Sonnet|Fable 5> limit · resets 3pm"
# family. Deliberately NOT matched: transient server 429s ("...(not your
# usage limit)") and spend caps / usage credits — waiting for the window
# reset won't clear those.
_LIMIT_RE = re.compile(
    r"usage limit reached"
    r"|you've (?:hit|reached) your (?:usage|session|weekly|opus|sonnet"
    r"|fable[\w .]*?|org's monthly usage) limit",
    re.IGNORECASE)


def is_limit_error(text: "str | None") -> bool:
    t = text or ""
    if "not your usage limit" in t.lower():
        return False
    return bool(_LIMIT_RE.search(t))


# Turn-death texts that mean "the API failed on its side, transiently": the
# CLI's "API Error: <5xx>" family, its prose variants, and the server-side 429
# that is explicitly not a usage limit (backing off is the whole point there).
# Not matched: auth/quota failures and anything a plain retry can't fix.
_SERVER_RE = re.compile(
    r"api error:\s*(?:5\d\d|server error)"
    r"|internal server error"
    r"|\boverloaded\b"
    r"|temporarily limiting requests",
    re.IGNORECASE)


def is_server_error(text: "str | None") -> bool:
    return bool(_SERVER_RE.search(text or ""))


def wait_str(epoch: float) -> str:
    s = max(0.0, epoch - time.time())
    return "now" if s < 30 else f"in {round(s / 60)} min"


def _reset_epoch(now: float) -> "float | None":
    """Latest reset among exhausted usage windows (a weekly at 100% makes the
    5-hour reset pointless). None when nothing reads as exhausted — e.g. the
    60s usage cache hasn't caught up yet — and the caller probes instead."""
    data = usage.get_usage()
    out = None
    for b in (data.get("five_hour"), data.get("seven_day")):
        if not b or (b.get("percent") or 0) < 99:
            continue
        ts = usage.resets_epoch(b.get("resets_at"))
        if ts and ts > now and (out is None or ts > out):
            out = ts
    return out


def when_str(epoch: float) -> str:
    fmt = "%a %H:%M" if epoch - time.time() > 86400 else "%H:%M"
    return time.strftime(fmt, time.localtime(epoch))


_lock = threading.Lock()
_pending: dict = {}       # session_id -> {chat_id, cwd, model, effort, tries, since, at, kind}
_last_tries: dict = {}    # session_id -> tries carried across a fire (episode memory)
_timer: "threading.Timer | None" = None
_fire_at: "float | None" = None


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "limit_resume.json")


def _save_locked() -> None:
    try:
        with open(_path(), "w") as f:
            json.dump(_pending, f, indent=2)
    except OSError as e:
        print(f"[limits] persist failed: {e}", file=sys.stderr)


def _arm_locked(target: float) -> None:
    # ponytail: one global timer at the earliest requested target. A session
    # deferred to a later reset just gets resumed early, fails, and re-defers;
    # per-session timers if that churn ever matters.
    global _timer, _fire_at
    if _timer is not None and _fire_at is not None and _fire_at <= target:
        return
    if _timer is not None:
        _timer.cancel()
    _fire_at = target
    _timer = threading.Timer(max(1.0, target - time.time()), _fire)
    _timer.daemon = True
    _timer.start()


def note_ok(session_id: str) -> None:
    """A turn completed on this session — its failure episode (if any) is over."""
    _last_tries.pop(session_id, None)


def _tries_locked(session_id: str) -> int:
    prev = _pending.get(session_id)
    return (prev["tries"] if prev else _last_tries.pop(session_id, 0)) + 1


def _park_locked(session_id: str, chat_id: int, cwd, model, effort,
                 tries: int, at: float, kind: str) -> None:
    _pending[session_id] = {"chat_id": chat_id, "cwd": cwd, "model": model,
                            "effort": effort, "tries": tries, "since": time.time(),
                            "at": at, "kind": kind}
    _save_locked()
    _arm_locked(at)


def defer(session_id: str, chat_id: int, cwd: "str | None",
          model: "str | None" = None, effort: "str | None" = None):
    """Park a limit-killed session for resume at reset. Returns (fire_at, first)
    — first is True on the episode's first defer (callers notify only then) —
    or None when the session exhausted MAX_TRIES (caller reports a plain error)."""
    now = time.time()
    with _lock:
        tries = _tries_locked(session_id)
        if tries > MAX_TRIES:
            return None
        reset = _reset_epoch(now)
        target = (reset + RESET_BUFFER) if reset else (now + RETRY_UNKNOWN)
        _park_locked(session_id, chat_id, cwd, model, effort, tries, target, "limit")
    return target, tries == 1


def defer_server(session_id: str, chat_id: int, cwd: "str | None",
                 model: "str | None" = None, effort: "str | None" = None):
    """Park a session killed by a transient API error for its next backoff step.
    Returns (fire_at, attempt) — attempt 1 fires immediately — or None once the
    ladder is exhausted (caller reports a plain error)."""
    now = time.time()
    with _lock:
        tries = _tries_locked(session_id)
        if tries > len(SERVER_BACKOFF):
            return None
        target = now + SERVER_BACKOFF[tries - 1]
        _park_locked(session_id, chat_id, cwd, model, effort, tries, target, "server")
    return target, tries


def _fire(run=None, notify=None) -> None:
    """Resume the deferred sessions this tick is for, re-arming for any left.

    Limit waits all go at once — an early one just re-probes and re-defers (see
    _arm_locked) — but a backoff step is that session's own wait, so a session
    still inside it stays parked and keeps the timer. run/notify are injectable
    for tests."""
    global _timer, _fire_at
    now = time.time()
    with _lock:
        _timer = None
        _fire_at = None
        entries = {k: v for k, v in _pending.items()
                   if v.get("kind") != "server" or v.get("at", 0) <= now + 1}
        for k in entries:
            _pending.pop(k, None)
        _save_locked()
        if _pending:
            _arm_locked(min(e.get("at", now) for e in _pending.values()))
    if not entries:
        return
    if run is None:
        from bridge import runner  # lazy: runner imports limits
        run = runner.start_streaming_job
    if notify is None:
        from bridge import telegram
        notify = telegram.send
    for sid, e in entries.items():
        if not config.is_owner(e.get("chat_id")):
            continue
        _last_tries[sid] = e.get("tries", 1)
        server = e.get("kind") == "server"
        try:
            job = run(e["chat_id"], SERVER_NUDGE if server else NUDGE, [],
                      project=e.get("cwd"), session_id=sid,
                      model=e.get("model"), effort=e.get("effort"))
        except Exception as ex:  # noqa: BLE001
            print(f"[limits] resume failed for {sid}: {ex}", file=sys.stderr)
            continue
        if job is None:
            note_ok(sid)     # session already running — the user moved on
            continue
        if not server and e.get("tries", 1) <= 1 and config.NOTIFY_ENABLE:
            # Server-error retries announced their wait at defer time, and
            # re-probes resume silently; the normal turn-done ping lands when
            # one finally completes.
            try:
                notify(e["chat_id"], "🔄 Usage limit reset — resuming your session.")
            except Exception:  # noqa: BLE001
                pass


def boot() -> None:
    """Re-arm after a bridge restart: persisted deferred sessions get a fresh
    timer — a limit wait recomputes its reset time (if the limit already reset,
    fire shortly), a backoff wait keeps the due time it was parked with."""
    try:
        with open(_path()) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    if not isinstance(data, dict) or not data:
        return
    now = time.time()
    reset = _reset_epoch(now)
    limit_at = (reset + RESET_BUFFER) if reset else (now + 60.0)
    with _lock:
        for sid, e in data.items():
            if not isinstance(e, dict):
                continue
            at = e.get("at") if e.get("kind") == "server" else None
            e["at"] = max(now + 5.0, at) if at else limit_at
            _pending.setdefault(sid, e)
        if not _pending:
            return
        _save_locked()
        _arm_locked(min(e.get("at", limit_at) for e in _pending.values()))
