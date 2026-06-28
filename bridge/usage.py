"""Claude usage (5-hour + 7-day limits) for the chat composer.

Reads the local OAuth access token from ~/.claude/.credentials.json, calls the
account usage endpoint, and returns only computed percentages / reset times /
severities. The token never leaves this process and is never returned to a
client. Results are cached for CACHE_TTL seconds so polling clients can't hammer
the upstream. On a missing/expired token or any upstream failure the result is
just {"available": False}. Stdlib only.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

CREDENTIALS_FILE = os.path.expanduser("~/.claude/.credentials.json")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CACHE_TTL = 60.0

_lock = threading.Lock()
_cache: dict = {"ts": 0.0, "data": None}


def _token() -> str | None:
    try:
        with open(CREDENTIALS_FILE) as f:
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
    limits = [{k: limit.get(k) for k in
               ("kind", "group", "percent", "severity", "resets_at", "is_active")}
              for limit in (payload.get("limits") or []) if isinstance(limit, dict)]
    return {
        "available": True,
        "five_hour": _bucket(payload.get("five_hour"), limits, "session"),
        "seven_day": _bucket(payload.get("seven_day"), limits, "weekly_all", "weekly"),
        "limits": limits,
    }


def get_usage() -> dict:
    now = time.time()
    with _lock:
        if _cache["data"] is not None and now - _cache["ts"] < CACHE_TTL:
            return _cache["data"]
    token = _token()
    data: dict = {"available": False}
    if token:
        payload = _fetch(token)
        if isinstance(payload, dict):
            data = _normalize(payload)
    with _lock:
        _cache["ts"] = now
        _cache["data"] = data
    return data
