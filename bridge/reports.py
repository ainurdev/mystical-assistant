"""Reports: a team install's crashes, sent to the team's one Sentry project
(ADR 0005, .mystical/tickets/speed-and-sentry/SPEC.md ▸ Reports).

The gate is decided once, in boot(), at bridge start: some enabled Rivendell
connection has TEAM_HOST as its API host, MYSTICAL_SENTRY is not "0", and DSN is
set. Anything else and this module stays inert: bridge/_vendor never reaches
sys.path and sentry_sdk is never imported, so another install's paths and prompt
lines cannot leave the machine. A connection added or switched off counts from
the next start, like the spec says; nothing here watches the store.

Why only these integrations: logging (a log line can carry chat text) and stdlib
(an http.client breadcrumb carries a URL, and a Telegram URL carries the bot
token) stay off, with everything the SDK would switch on by itself. What is left
catches errors: the excepthook, threads, dedupe, the flush at exit.

Why a scrubber on top of the SDK's own settings: an error message can quote
anything, a token included. _scrub runs on every event in before_send, so one
place decides what leaves. It is deliberately blunt (every string capped, every
breadcrumb dropped): a report is for finding the bug, not for reading the chat.

Sending never waits: capture_* only queues, the SDK's worker thread sends, its
transport times out in _SEND_TIMEOUT, and a dead receiver changes nothing else.
"""

import os
import platform
import re
import sys
import threading
import time
from collections import deque
from urllib.parse import urlparse

from bridge import config

# Public by design: a DSN can send events, never read them.
DSN = "https://76da3cd86191afd0e2b0126ffd4d68a0@o4512487081705472.ingest.de.sentry.io/4512487086620753"
TEAM_HOST = "api.rivendell.ainurhq.cloud"
VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_vendor")

_SEND_TIMEOUT = 5          # seconds, per send, on the SDK's own thread
_SAME_EVERY = 60           # the same crash at most once a minute
_HOUR_CAP = 100            # reports an hour from this side
_CAP = 1000                # every string, a message included
_PROMPT_CAP = 120          # a prompt keeps its first line, this long at most

_sdk = None                # sentry_sdk, once the gate said yes
_team: "dict | None" = None
_lock = threading.Lock()
_last: dict = {}           # crash key -> when it was last sent
_sent: deque = deque()     # send times in the last hour


def _os() -> str:
    if sys.platform == "darwin":
        return "macos"
    return "wsl" if "microsoft" in platform.release().lower() else "linux"


def _team_connection() -> "dict | None":
    from bridge import rivendell_instances
    return next((i for i in rivendell_instances.raw_instances()
                 if i.get("enable") and urlparse(i.get("api_url") or "").hostname == TEAM_HOST), None)


def boot() -> bool:
    """Decide the gate and, on a team install, start the SDK. Called once,
    after selfupdate.boot() (the release) and envsettings.apply()."""
    global _sdk, _team
    if not DSN or os.environ.get("MYSTICAL_SENTRY") == "0":
        return False
    _team = _team_connection()
    if not _team:
        return False
    sys.path.insert(0, VENDOR)
    try:
        import sentry_sdk
        from sentry_sdk.integrations.atexit import AtexitIntegration
        from sentry_sdk.integrations.dedupe import DedupeIntegration
        from sentry_sdk.integrations.excepthook import ExcepthookIntegration
        from sentry_sdk.integrations.threading import ThreadingIntegration
        from sentry_sdk.transport import HttpTransport
        from bridge import selfupdate
        sentry_sdk.init(
            dsn=DSN,
            release=selfupdate.BOOT_HEAD or None,
            default_integrations=False,
            auto_enabling_integrations=False,
            integrations=[ExcepthookIntegration(), ThreadingIntegration(), DedupeIntegration(), AtexitIntegration()],
            data_collection={"user_info": False, "stack_frame_variables": False, "http_bodies": []},
            max_request_body_size="never",
            auto_session_tracking=False,
            send_client_reports=False,
            before_send=_before_send,
            before_breadcrumb=lambda crumb, hint: None,
            transport=type("_Transport", (HttpTransport,), {"TIMEOUT": _SEND_TIMEOUT}),
            shutdown_timeout=2,
        )
    except Exception as e:  # noqa: BLE001 - reporting must never stop the bridge from starting
        sys.path.remove(VENDOR)
        print(f"reports: off, the Sentry SDK did not start: {type(e).__name__}: {e}", file=sys.stderr)
        return False
    _sdk = sentry_sdk
    return True


def on() -> bool:
    return _sdk is not None


def status() -> dict:
    """GET /local/reports: what the page needs to start its own half."""
    if not on():
        return {"on": False}
    return {"on": True, "dsn": DSN, "user": _team.get("name") or "", "os": _os()}


# ---------------------------------------------------------------------------
# Crashes
# ---------------------------------------------------------------------------

_ID = re.compile(r"^(?:\d+|(?=[\w-]*\d)[\w-]{6,})$")


def route(path: str) -> str:
    """A request path as a pattern: the query gone, every id-like segment ':id'."""
    return "/".join(":id" if _ID.match(seg) else seg for seg in urlparse(path).path.split("/"))


def request_crash(surface: str, method: str, path: str, exc: BaseException) -> None:
    """A dashboard or Mini App request raised past its handler."""
    if on():
        _sdk.capture_exception(exc, tags={"route": f"{method} {route(path)}", "surface": surface})


def turn_ended(job) -> None:
    """At an error turn's end: a report when its outcome is CRASHED. Judged off
    the job, not the store, whose events are still being journaled."""
    if not (on() and job.store_session_id):
        return
    try:
        _turn_crash(job)
    except Exception as e:  # noqa: BLE001 - a report never breaks the runner's finally
        _sdk.capture_exception(e)


def _turn_crash(job) -> None:
    from bridge import outcomes, paths, store
    errors = [e.get("message") or "" for e in list(job.events) if e.get("type") == "error"]
    turn = {"status": "error", "elapsed": job.elapsed, "cost": job.cost, "runtime": job.runtime}
    if (outcomes.outcome(turn, {"errors": errors, "result_text": job.result}) or {}).get("code") != "crashed":
        return
    t = store.last_turn(job.store_session_id) or {}
    sess = store.get_session(job.store_session_id) or {}
    flow = paths.get(job.store_session_id) or {}
    _sdk.capture_message(
        "turn crashed: " + next((m for m in reversed(errors) if m.strip()), job.result or ""),
        level="error",
        tags={"surface": "turn"},
        contexts={"turn": {
            "session": job.store_session_id, "project": sess.get("project"),
            "account": job.runtime or (f"claude:{job.account_slot}" if job.account_slot else "default"),
            "model": job.model, "flow": flow.get("path"), "step": (flow.get("next") or {}).get("station"),
            "prompt": t.get("prompt") or "" if t.get("id") == job.id else "",
        }},
    )


# ---------------------------------------------------------------------------
# What leaves: scrub, stamp, cap
# ---------------------------------------------------------------------------

_FILTERED = "[Filtered]"
_SHAPES = [
    (re.compile(r"sk-ant-[\w-]+"), _FILTERED),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})"), _FILTERED),
    (re.compile(r"\bBearer\s+[\w.~+/=-]+", re.I), "Bearer " + _FILTERED),
    (re.compile(r"\bbot\d+:[\w-]+"), "bot" + _FILTERED),
]
_QUERY = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s?#\"'<>]*)\?[^\s#\"'<>]*", re.I)
_SECRET_ENV = re.compile(r"(?:KEY|TOKEN|SECRET|PASSWORD)$")


def _secrets() -> list:
    """Every secret the bridge holds, longest first so a longer one that holds
    a shorter one goes whole. Claude logins' OAuth tokens are read from the
    Keychain only on demand, so they are caught by their sk-ant- shape instead."""
    from bridge import rivendell_instances
    held = {config.DASH_TOKEN, config.TOKEN, config.RIVENDELL_TOKEN}
    held |= {i.get("token") for i in rivendell_instances.raw_instances()}
    held |= {v for k, v in os.environ.items() if _SECRET_ENV.search(k)}
    return sorted((s for s in held if s and len(s) >= 8), key=len, reverse=True)


def _text(s: str, key: str, held: list) -> str:
    for sec in held:
        s = s.replace(sec, _FILTERED)
    for rx, sub in _SHAPES:
        s = rx.sub(sub, s)
    s = _QUERY.sub(r"\1", s)
    if key == "prompt":
        return s.split("\n", 1)[0][:_PROMPT_CAP]
    return s[:_CAP]


def _scrub(v, held: list, key: str = ""):
    if isinstance(v, dict):
        return {k: _scrub(x, held, k) for k, x in v.items() if k not in ("vars", "breadcrumbs")}
    if isinstance(v, (list, tuple)):
        return [_scrub(x, held, key) for x in v]
    if isinstance(v, str):
        return _text(v, key, held)
    return v


def _key(event: dict) -> str:
    """What makes two crashes the same: the exception's type and where it was
    raised, else the message."""
    if vals := (event.get("exception") or {}).get("values"):
        top = ((vals[-1].get("stacktrace") or {}).get("frames") or [{}])[-1]
        return f"{vals[-1].get('type')}@{top.get('abs_path') or top.get('filename')}:{top.get('lineno')}"
    msg = event.get("logentry") or {}
    return str(msg.get("message") if isinstance(msg, dict) else msg) or str(event.get("message"))


def _allowed(key: str) -> bool:
    now = time.monotonic()
    with _lock:
        while _sent and now - _sent[0] > 3600:
            _sent.popleft()
        if len(_sent) >= _HOUR_CAP or now - _last.get(key, -_SAME_EVERY) < _SAME_EVERY:
            return False
        _last[key] = now
        _sent.append(now)
        return True


def _before_send(event: dict, hint) -> "dict | None":
    if not _allowed(_key(event)):
        return None
    event = _scrub(event, _secrets())
    event["tags"] = {**(event.get("tags") or {}), "side": "bridge", "os": _os()}
    event["user"] = {"username": _team.get("name") or ""}
    return event
