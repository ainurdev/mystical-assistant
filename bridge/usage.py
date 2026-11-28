"""Claude usage (5-hour + 7-day limits) for the chat composer.

Read through Claude Code itself, never with the login's token: a `get_usage`
control request to a short-lived `claude -p` pointed at the login
(CLAUDE_CONFIG_DIR) answers with the plan's windows, the same keys the OAuth
usage endpoint returns plus each limit's severity. No prompt and no model call
(CLI 2.1.316: 0.7 s, 0 tokens), the CLI renews its own token, and all of the
bridge's Anthropic traffic stays inside the official binary. That is why it
replaced reading the token and polling /api/oauth/usage, which 429'd readily and
read UNKNOWN whenever an idle login's access token had lapsed.

A spawn is dearer than an HTTP call, so a read is kept CACHE_TTL and the turns
themselves do the rest: every rate_limit_event a running turn sees lands here
(note_event) as a live reading of the windows it names. Each login's payload
says when it was read (read_at) and when a turn last reported it (live_at); the
composer prints "live" or "N min ago" from those. A failed read serves the last
good payload for up to STALE_MAX. {"available": False} means we have nothing at
all. Stdlib only.
"""

import json
import os
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone

from bridge import credentials

CREDENTIALS_FILE = os.path.expanduser("~/.claude/.credentials.json")
CACHE_TTL = 300.0   # a read spawns claude: the live events fill in between
RETRY_TTL = 60.0    # read failed and there's nothing to show: try again sooner
CLI_TIMEOUT = 20.0  # get_usage answers in under a second; a hung child is killed
LIVE_WINDOW = 180.0 # a turn's rate_limit_event counts as "live" this long
STALE_MAX = 900.0   # how long a last-good payload may stand in for a live one
PACE_SPAN = 3600.0  # pace() reads the last hour of 5-hour readings
PACE_MIN = 600.0    # under ten minutes of readings is noise, not a pace

_lock = threading.Lock()
# creds path -> last *successful* fetch for that account. Keyed by path because
# the fallback ladder reads several accounts' meters and one must never stand in
# for another (picking the next account depends on these numbers being its own).
_cache: dict = {}


def _entry(path: str) -> dict:
    return _cache.setdefault(path, {"ts": 0.0, "data": None, "next_try": 0.0})


def _token(path: str) -> str | None:
    oauth = credentials.load(path).get("claudeAiOauth") or {}
    exp = oauth.get("expiresAt")
    if isinstance(exp, (int, float)) and exp and time.time() * 1000 > exp:
        return None  # token expired
    return oauth.get("accessToken") or None


def has_token(path: str) -> bool:
    """A login the CLI can still use: a live access token, or a refresh token it
    renews one from on its next run. An idle login's access token lapses within
    hours; that only leaves its meter unreadable until it runs again. False is
    the one unreadable-meter state that waiting doesn't fix: the login has to
    be redone."""
    oauth = credentials.load(path).get("claudeAiOauth") or {}
    return bool(oauth.get("refreshToken")) or _token(path) is not None


def _config_dir(path: str) -> "str | None":
    """The CLAUDE_CONFIG_DIR a credentials path belongs to; None for the ambient
    ~/.claude login, which runs with the variable unset."""
    d = os.path.dirname(path)
    return None if os.path.abspath(d) == os.path.abspath(os.path.dirname(CREDENTIALS_FILE)) else d


def _fetch(path: str) -> dict | None:
    """The plan's rate limits as Claude Code reads them for this login: the
    get_usage reply's rate_limits, or None (no CLI, no subscription, a timeout)."""
    from bridge import runner   # lazy: runner imports the world
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
    if (cfg := _config_dir(path)):
        env["CLAUDE_CONFIG_DIR"] = cfg
    req = {"type": "control_request", "request_id": "usage",
           "request": {"subtype": "get_usage", "skip_behaviors": True}}
    try:
        out = subprocess.run(
            [runner.claude_bin(), "-p", "--output-format", "stream-json", "--verbose",
             "--input-format", "stream-json"],
            input=json.dumps(req) + "\n", capture_output=True, text=True,
            timeout=CLI_TIMEOUT, env=env, cwd=tempfile.gettempdir()).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        r = (d.get("response") or {}) if d.get("type") == "control_response" else {}
        if r.get("subtype") == "success" and r.get("request_id") == "usage":
            body = r.get("response") or {}
            rl = body.get("rate_limits")
            return rl if body.get("rate_limits_available", True) and isinstance(rl, dict) else None
    return None


def resets_epoch(v) -> float | None:
    """A window's resets_at -> epoch seconds. Accepts epoch (s or ms) or
    ISO-8601; None when it parses as neither."""
    if isinstance(v, (int, float)):
        return float(v) / (1000.0 if v > 1e12 else 1.0)
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _sev(limits: list[dict], *kinds: str) -> str:
    for limit in limits:
        if limit.get("kind") in kinds or limit.get("group") in kinds:
            return limit.get("severity") or "normal"
    return "normal"


def _bucket(d, limits, *kinds) -> dict | None:
    if not isinstance(d, dict):
        return None
    u = d.get("utilization")
    if u is None:
        return None
    return {"percent": round(float(u)), "resets_at": d.get("resets_at"),
            "severity": _sev(limits, *kinds)}


def _normalize(payload: dict) -> dict:
    # scope names the model a weekly_scoped limit belongs to ({"model":
    # {"display_name": "Fable", ...}}) — the pickers pair it to a row by that.
    limits = [{k: limit.get(k) for k in
               ("kind", "group", "percent", "severity", "resets_at", "is_active", "scope")}
              for limit in (payload.get("limits") or []) if isinstance(limit, dict)]
    return {
        "available": True,
        "five_hour": _bucket(payload.get("five_hour"), limits, "session"),
        "seven_day": _bucket(payload.get("seven_day"), limits, "weekly_all", "weekly"),
        "limits": limits,
    }


def _remember(e: dict, now: float, payload: dict) -> None:
    """Keep this login's 5-hour reading for pace(): the last hour of it, and only
    this window's. A reading above the new one means the window rolled since."""
    b = payload.get("five_hour")
    u = b.get("utilization") if isinstance(b, dict) else None
    refill = resets_epoch(b.get("resets_at")) if isinstance(b, dict) else None
    if u is None or refill is None:
        return
    e["hist"] = [h for h in e.get("hist", ())
                 if now - h[0] <= PACE_SPAN and abs(h[2] - refill) < 300 and h[1] <= u]
    e["hist"].append((now, float(u), refill))


def _pace(hist: list, now: float) -> "str | None":
    """When the window runs out at the rate since the oldest reading, or None:
    too little to tell, not climbing, or it refills first. First and last
    reading, not a fitted line: use comes in bursts, and where the hour began
    to where it is now is the rate a person would quote."""
    hist = [h for h in hist if now - h[0] <= PACE_SPAN]
    if len(hist) < 2:
        return None
    (t0, u0, _), (t1, u1, refill) = hist[0], hist[-1]
    if t1 - t0 < PACE_MIN or u1 <= u0 or u1 >= 100:
        return None
    out = t1 + (100.0 - u1) * (t1 - t0) / (u1 - u0)
    return None if out >= refill else datetime.fromtimestamp(out, timezone.utc).isoformat()


def pace(creds_path: str | None = None) -> "str | None":
    """When this login's 5-hour window runs out at the last hour's rate (ISO-8601),
    if that comes before it refills. Readings are the ones get_usage() made, so
    there is a pace only while something polls the meter (an open dashboard)."""
    with _lock:
        hist = list(_entry(creds_path or CREDENTIALS_FILE).get("hist", ()))
    return _pace(hist, time.time())


def _view(e: dict) -> dict:
    """The cached payload with when it was read and whether a turn is reporting it."""
    data = e.get("data")
    if data is None:
        return {"available": False}
    live_at = e.get("live_at") or 0.0
    return {**data, "read_at": max(e.get("ts") or 0.0, live_at) or None,
            "live": time.time() - live_at < LIVE_WINDOW,
            # a turn's word on the limit, until a read through the CLI is newer
            "status": e.get("status") if live_at and live_at >= (e.get("ts") or 0.0) else None}


# rate_limit_event's per-window status -> the meter's severity words
_SEV_OF = {"allowed": "normal", "allowed_warning": "warning", "rejected": "exceeded"}
_WINDOW_KEY = {"five_hour": "five_hour", "seven_day": "seven_day"}


def note_event(creds_path: "str | None", info: dict) -> None:
    """A running turn's rate_limit_event, as a live reading of the windows it
    names. utilization is a fraction there (0.67), resetsAt epoch seconds."""
    if not isinstance(info, dict):
        return
    windows = dict(info.get("unifiedWindows") or {})
    if not windows and info.get("rateLimitType"):
        windows[info["rateLimitType"]] = info
    path, now = creds_path or CREDENTIALS_FILE, time.time()
    with _lock:
        e = _entry(path)
        data = dict(e["data"] or {"available": True, "five_hour": None,
                                  "seven_day": None, "limits": []})
        for name, w in windows.items():
            key, u = _WINDOW_KEY.get(name), (w or {}).get("utilization")
            if key is None or u is None:
                continue
            reset = resets_epoch(w.get("resetsAt"))
            data[key] = {"percent": round(float(u) * 100),
                         "resets_at": datetime.fromtimestamp(reset, timezone.utc).isoformat() if reset else None,
                         "severity": _SEV_OF.get(w.get("status"), "normal")}
            if key == "five_hour":
                _remember(e, now, {"five_hour": {"utilization": data[key]["percent"],
                                                 "resets_at": data[key]["resets_at"]}})
        e.update(data=data, live_at=now, status=info.get("status"))


def cached(creds_path: str | None = None) -> dict:
    """What get_usage() would serve from the cache, never reading anew: for a
    caller that looks often (the Live board) and must not spawn claude."""
    with _lock:
        e = _entry(creds_path or CREDENTIALS_FILE)
        fresh = e["ts"] and time.time() - e["ts"] < STALE_MAX
        return _view(e) if fresh or e.get("live_at") else {"available": False}


def _saved_file() -> str:
    from bridge import config
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "meters.json")


def _load_saved() -> dict:
    """The last run's good readings, creds path -> {ts, data}; {} when missing or garbled."""
    try:
        with open(_saved_file(), encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(saved, dict):
        return {}
    return {p: e for p, e in saved.items() if isinstance(e, dict)
            and isinstance(e.get("ts"), (int, float)) and isinstance(e.get("data"), dict)}


_save_lock = threading.Lock()


def _save() -> None:
    """Each login's last good read, over what the file had: a temp file, then a replace."""
    with _lock:
        good = {p: {"ts": e["ts"], "data": e["data"]} for p, e in _cache.items()
                if e["ts"] and e["data"] is not None}
    with _save_lock:
        try:
            with open(_saved_file() + ".tmp", "w", encoding="utf-8") as f:
                json.dump({**_load_saved(), **good}, f)
            os.replace(_saved_file() + ".tmp", _saved_file())
        except OSError:
            pass   # the next start reads every login, as before


_boot = _load_saved()   # what the file had at start; a login uses it until its first read
_behind: set = set()    # logins being read behind the meter on screen


def shown(creds_path: str | None = None) -> "dict | None":
    """For a screen only, never for picking an Account: a reading past CACHE_TTL
    answers at once, keeping the time it was read, while a fresh one is read behind;
    so does the last run's, for a login this process hasn't read yet. A failed read's
    retry is read behind as well, and the ask gets what get_usage() answers while
    that retry waits, so the meter doesn't flip from poll to poll. A login whose meter
    can't be read held every second poll for 1.3 to 2.6 s (Sentry MYSTICAL-A, -B).
    None while the reading is fresh, past STALE_MAX with no failed read before it
    (not every screen prints its age), a failed read waits for its retry, or nothing
    was ever read: get_usage() answers those."""
    path = creds_path or CREDENTIALS_FILE
    now = time.time()
    with _lock:
        e, hit = _entry(path), _boot.get(path)
        if 0 < e["next_try"] <= now:          # the last read failed and its wait is over
            good = (e["ts"] and now - e["ts"] < STALE_MAX) or e.get("live_at")
            view = _view(e) if good else {"available": False}
        elif e["data"] is not None:
            if now - e["ts"] < CACHE_TTL or now < e["next_try"]:
                return None
            view = _view(e)
        elif hit is None or e["next_try"]:
            return None
        else:
            view = _view({"ts": hit["ts"], "data": hit["data"]})
        if not e["next_try"] and now - (view.get("read_at") or 0.0) >= STALE_MAX:
            return None
        start = path not in _behind
        _behind.add(path)
    if start:
        threading.Thread(target=_read_behind, args=(path,), daemon=True,
                         name="meter-behind").start()
    return view


def _read_behind(path: str) -> None:
    try:
        get_usage(path)
    finally:
        with _lock:
            _behind.discard(path)


def get_usage(creds_path: str | None = None, max_age: float = CACHE_TTL) -> dict:
    """Usage for one account. creds_path=None is the ambient ~/.claude login;
    max_age=0 reads it now (the PROFILE menu's Check now)."""
    path = creds_path or CREDENTIALS_FILE
    now = time.time()
    with _lock:
        e = _entry(path)
        data, ts, next_try = e["data"], e["ts"], e["next_try"]
        if data is not None and now - ts < max_age:
            return _view(e)
        if now < next_try and max_age:          # read recently and it failed
            return _view(e) if now - ts < STALE_MAX or e.get("live_at") else {"available": False}
    from bridge import reports   # lazy, as _saved_file's config is: reports imports config
    with reports.outside():      # a `claude -p`, by design: the first read, or one past STALE_MAX
        payload = _fetch(path)
    with _lock:
        e = _entry(path)
        if isinstance(payload, dict):
            e.update(ts=now, data=_normalize(payload), next_try=0.0)
            _remember(e, now, payload)
        else:
            # A value still on screen buys a full cycle before we try again; an
            # empty meter is worth retrying sooner.
            e["next_try"] = now + (CACHE_TTL if e["data"] is not None else RETRY_TTL)
        fresh = e["ts"] and now - e["ts"] < STALE_MAX
        out = _view(e) if fresh or e.get("live_at") else {"available": False}
    if isinstance(payload, dict):
        _save()
    return out
