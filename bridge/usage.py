"""Claude usage (5-hour + 7-day limits) for the chat composer.

Reads the local OAuth access token from ~/.claude/.credentials.json, calls the
account usage endpoint, and returns only computed percentages / reset times /
severities. The token never leaves this process and is never returned to a
client. Results are cached for CACHE_TTL seconds so polling clients can't hammer
the upstream.

The endpoint rate-limits (429) readily — the Claude CLI polls it too — so a
failed fetch serves the last good payload for up to STALE_MAX rather than
blanking the clients' meters. {"available": False} means we have nothing at all:
no token, or no successful call recent enough to still be true. Stdlib only.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

CREDENTIALS_FILE = os.path.expanduser("~/.claude/.credentials.json")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CACHE_TTL = 60.0
RETRY_TTL = 15.0    # fetch failed and there's nothing to show: probe again sooner
STALE_MAX = 900.0   # how long a last-good payload may stand in for a live one

_lock = threading.Lock()
# creds path -> last *successful* fetch for that account. Keyed by path because
# the fallback ladder reads several accounts' meters and one must never stand in
# for another (picking the next account depends on these numbers being its own).
_cache: dict = {}


def _entry(path: str) -> dict:
    return _cache.setdefault(path, {"ts": 0.0, "data": None, "next_try": 0.0})


def _token(path: str) -> str | None:
    try:
        with open(path) as f:
            oauth = json.load(f).get("claudeAiOauth") or {}
    except (OSError, ValueError):
        return None
    exp = oauth.get("expiresAt")
    if isinstance(exp, (int, float)) and exp and time.time() * 1000 > exp:
        return None  # token expired
    return oauth.get("accessToken") or None


def _fetch(token: str) -> dict | None:
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError):
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


def _last_good(data: "dict | None", age: float) -> dict:
    """The previous payload, while it's recent enough to still be true."""
    return data if data is not None and age < STALE_MAX else {"available": False}


def get_usage(creds_path: str | None = None) -> dict:
    """Usage for one account. creds_path=None is the ambient ~/.claude login."""
    path = creds_path or CREDENTIALS_FILE
    now = time.time()
    with _lock:
        e = _entry(path)
        data, ts, next_try = e["data"], e["ts"], e["next_try"]
    if data is not None and now - ts < CACHE_TTL:
        return data
    if now < next_try:                      # fetched recently and it failed
        return _last_good(data, now - ts)
    token = _token(path)
    payload = _fetch(token) if token else None
    if isinstance(payload, dict):
        fresh = _normalize(payload)
        with _lock:
            _entry(path).update(ts=now, data=fresh, next_try=0.0)
        return fresh
    with _lock:
        # A value still on screen buys a full cycle before we try again; an
        # empty meter is worth retrying sooner.
        _entry(path)["next_try"] = now + (CACHE_TTL if data is not None
                                         else RETRY_TTL)
    return _last_good(data, now - ts)
