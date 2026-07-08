"""Usage-limit aware auto-resume.

When a turn dies because the Claude account hit a usage limit (5-hour /
weekly / per-model window), the runner's immediate crash auto-resume would
just fail again while the window is exhausted and burn its retry cap. The
runner defers the session here instead: we remember it (persisted next to
the DB as limit_resume.json, so a bridge restart during the wait loses
nothing), arm one timer for the reset time read from the OAuth usage
endpoint (bridge/usage.py), and resume every deferred session with a nudge
when it fires. A resume that finds the account still limited errors with
the same limit message and lands right back here — self-healing, capped at
MAX_TRIES consecutive attempts per session.
"""

import json
import os
import re
import sys
import threading
import time
from datetime import datetime

from bridge import config, usage

RESET_BUFFER = 90.0     # fire a bit after the advertised reset
RETRY_UNKNOWN = 1800.0  # reset time unknown (stale/absent usage data): probe again
MAX_TRIES = 12          # consecutive limit-deferred resumes per session before giving up

NUDGE = (
    "⏮ Your previous turn was cut off because the Claude usage limit was "
    "reached — not by the user. The limit has reset. Review your recent "
    "transcript and continue exactly where you left off; finish the task "
    "you were doing. Don't start over.")

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


def _ts(v) -> "float | None":
    """resets_at → epoch seconds. Accepts epoch (s or ms) or ISO-8601."""
    if isinstance(v, (int, float)):
        return float(v) / (1000.0 if v > 1e12 else 1.0)
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _reset_epoch(now: float) -> "float | None":
    """Latest reset among exhausted usage windows (a weekly at 100% makes the
    5-hour reset pointless). None when nothing reads as exhausted — e.g. the
    60s usage cache hasn't caught up yet — and the caller probes instead."""
    data = usage.get_usage()
    out = None
    for b in (data.get("five_hour"), data.get("seven_day")):
        if not b or (b.get("percent") or 0) < 99:
            continue
        ts = _ts(b.get("resets_at"))
        if ts and ts > now and (out is None or ts > out):
            out = ts
    return out


def when_str(epoch: float) -> str:
    fmt = "%a %H:%M" if epoch - time.time() > 86400 else "%H:%M"
    return time.strftime(fmt, time.localtime(epoch))


_lock = threading.Lock()
_pending: dict = {}       # session_id -> {chat_id, cwd, model, effort, tries, since}
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
    """A turn completed on this session — its limit episode (if any) is over."""
    _last_tries.pop(session_id, None)


def defer(session_id: str, chat_id: int, cwd: "str | None",
          model: "str | None" = None, effort: "str | None" = None):
    """Park a limit-killed session for resume at reset. Returns (fire_at, first)
    — first is True on the episode's first defer (callers notify only then) —
    or None when the session exhausted MAX_TRIES (caller reports a plain error)."""
    now = time.time()
    with _lock:
        prev = _pending.get(session_id)
        tries = (prev["tries"] if prev else _last_tries.pop(session_id, 0)) + 1
        if tries > MAX_TRIES:
            return None
        reset = _reset_epoch(now)
        target = (reset + RESET_BUFFER) if reset else (now + RETRY_UNKNOWN)
        _pending[session_id] = {"chat_id": chat_id, "cwd": cwd, "model": model,
                                "effort": effort, "tries": tries, "since": now}
        _save_locked()
        _arm_locked(target)
    return target, tries == 1


def _fire(run=None, notify=None) -> None:
    """Resume every deferred session. run/notify are injectable for tests."""
    global _timer, _fire_at
    with _lock:
        _timer = None
        _fire_at = None
        entries = dict(_pending)
        _pending.clear()
        _save_locked()
    if not entries:
        return
    if run is None:
        from bridge import runner  # lazy: runner imports limits
        run = runner.start_streaming_job
    if notify is None:
        from bridge import telegram
        notify = telegram.send
    for sid, e in entries.items():
        if e.get("chat_id") not in config.ALLOWED_CHAT_IDS:
            continue
        _last_tries[sid] = e.get("tries", 1)
        try:
            job = run(e["chat_id"], NUDGE, [], project=e.get("cwd"),
                      session_id=sid, model=e.get("model"), effort=e.get("effort"))
        except Exception as ex:  # noqa: BLE001
            print(f"[limits] resume failed for {sid}: {ex}", file=sys.stderr)
            continue
        if job is None:
            note_ok(sid)     # session already running — the user moved on
            continue
        if e.get("tries", 1) <= 1 and config.NOTIFY_ENABLE:
            # Re-probes resume silently; the normal turn-done ping lands when
            # one finally completes.
            try:
                notify(e["chat_id"], "🔄 Usage limit reset — resuming your session.")
            except Exception:  # noqa: BLE001
                pass


def boot() -> None:
    """Re-arm after a bridge restart: persisted deferred sessions get a fresh
    timer (reset time recomputed; if the limit already reset, fire shortly)."""
    try:
        with open(_path()) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    if not isinstance(data, dict) or not data:
        return
    now = time.time()
    reset = _reset_epoch(now)
    target = (reset + RESET_BUFFER) if reset else (now + 60.0)
    with _lock:
        for sid, e in data.items():
            if isinstance(e, dict):
                _pending.setdefault(sid, e)
        _save_locked()
        _arm_locked(target)
