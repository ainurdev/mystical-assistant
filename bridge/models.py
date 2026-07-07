"""Live model list from the Anthropic Models API.

Claude ships no CLI command to enumerate models, but `GET /v1/models` does — and
Claude Code's own OAuth credentials (~/.claude/.credentials.json) can call it. We
fetch the account's available models (full ids + display names) and serve them to
the chat pickers, so the list is the real one rather than a hardcode. The result
is cached to avoid hitting the API on every /state poll, and falls back to the
curated config list when the token or API is unavailable.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request

from bridge import config

_CREDS = os.path.expanduser("~/.claude/.credentials.json")
_TTL = 3600.0     # cache a good fetch this long (s)
_RETRY = 60.0     # after a failure, retry the API this soon (s)
_cache: tuple[float, list[dict]] | None = None  # (expires_at_monotonic, models)
_cache_lock = threading.Lock()
_refreshing = False


def _oauth_token() -> str | None:
    """Claude Code's subscription OAuth access token, if present on disk."""
    try:
        with open(_CREDS) as f:
            return (json.load(f).get("claudeAiOauth") or {}).get("accessToken")
    except (OSError, ValueError):
        return None


def _fallback() -> list[dict]:
    """Curated config aliases, used only when the Models API is unreachable."""
    labels = {"opus": "Opus", "sonnet": "Sonnet", "haiku": "Haiku", "fable": "Fable"}
    return [{"id": m, "label": labels.get(m, m)} for m in config.MINIAPP_MODELS]


def _fetch() -> list[dict] | None:
    """GET /v1/models with Claude Code's OAuth token. None on any failure."""
    tok = _oauth_token()
    if not tok:
        return None
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/models?limit=1000",
        headers={
            "Authorization": f"Bearer {tok}",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r).get("data", [])
    except (urllib.error.URLError, ValueError, TimeoutError, OSError):
        return None
    out = [
        {"id": m["id"], "label": m.get("display_name") or m["id"]}
        for m in data
        if m.get("id")
    ]
    return out or None


def _refresh() -> None:
    """One in-flight fetch at a time; stores the result (or a retry-windowed
    fallback) and never raises."""
    global _cache, _refreshing
    fetched = _fetch()
    now = time.monotonic()
    with _cache_lock:
        if fetched is not None:
            _cache = (now + _TTL, fetched)
        elif _cache is None or now >= _cache[0]:
            _cache = (now + _RETRY, _fallback())  # retry soon; don't hammer it
        _refreshing = False


def get_models() -> list[dict]:
    """[{id, label}] the account can use, in the API's order (newest first).
    Never blocks on the network: this sits on the /state poll and the run-submit
    path, so a stale (or missing) cache serves the last-known/fallback list
    immediately and refreshes in a background thread."""
    global _refreshing
    with _cache_lock:
        cached = _cache
        stale = cached is None or time.monotonic() >= cached[0]
        if stale and not _refreshing:
            _refreshing = True
            threading.Thread(target=_refresh, daemon=True).start()
    return cached[1] if cached else _fallback()


def model_ids() -> set[str]:
    """The set of valid model ids to validate a run request against."""
    return {m["id"] for m in get_models()}
