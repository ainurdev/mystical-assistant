"""Unit tests for the usage cache (bridge/usage.py).
Run directly: `python tests/test_usage.py` (or with pytest).

The upstream endpoint 429s readily, so the contract under test is: a failed
fetch keeps serving the last good payload instead of blanking the meters.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import usage  # noqa: E402

PAYLOAD = {"five_hour": {"utilization": 7, "resets_at": "2026-07-30T10:00:00+00:00"},
           "seven_day": {"utilization": 13, "resets_at": "2026-08-05T12:00:00+00:00"},
           "limits": [{"kind": "session", "group": "session", "severity": "normal"}]}


def _stub(*fetches):
    """Patch token/_fetch; _fetch returns each item in turn (None = failure).
    Returns (restore, calls) where calls[0] counts fetch attempts."""
    saved_token, saved_fetch = usage._token, usage._fetch
    seq, calls = list(fetches), [0]

    def fetch(_token):
        calls[0] += 1
        return seq.pop(0) if seq else None

    usage._token = lambda _path: "sk-ant-oat01-test"
    usage._fetch = fetch
    usage._cache.clear()
    return (lambda: (setattr(usage, "_token", saved_token),
                     setattr(usage, "_fetch", saved_fetch),
                     usage._cache.clear())), calls


def _default_entry() -> dict:
    """The cache slot the no-argument get_usage() uses."""
    return usage._entry(usage.CREDENTIALS_FILE)


def test_success_normalizes_and_caches():
    restore, calls = _stub(PAYLOAD)
    try:
        first = usage.get_usage()
        assert first["available"] is True
        assert first["five_hour"]["percent"] == 7
        assert first["seven_day"]["percent"] == 13
        assert usage.get_usage() is first      # served from cache
        assert calls[0] == 1
    finally:
        restore()


def test_failure_serves_last_good():
    restore, calls = _stub(PAYLOAD, None)
    try:
        good = usage.get_usage()
        _default_entry()["ts"] = time.time() - usage.CACHE_TTL - 1   # cache expired
        assert usage.get_usage() == good       # 429 doesn't blank the meter
        assert calls[0] == 2
    finally:
        restore()


def test_failure_without_history_is_unavailable():
    restore, _ = _stub(None)
    try:
        assert usage.get_usage() == {"available": False}
    finally:
        restore()


def test_failed_fetch_is_not_retried_on_every_call():
    restore, calls = _stub(PAYLOAD, None)
    try:
        usage.get_usage()
        _default_entry()["ts"] = time.time() - usage.CACHE_TTL - 1
        for _ in range(4):
            usage.get_usage()
        assert calls[0] == 2                   # one failure, then backed off
    finally:
        restore()


def test_empty_meter_retries_sooner_than_a_stale_one():
    restore, _ = _stub(None)
    try:
        now = time.time()
        usage.get_usage()                      # nothing cached → RETRY_TTL
        assert _default_entry()["next_try"] - now < usage.CACHE_TTL
    finally:
        restore()


def test_last_good_expires():
    restore, _ = _stub(PAYLOAD, None)
    try:
        usage.get_usage()
        _default_entry()["ts"] = time.time() - usage.STALE_MAX - 1
        assert usage.get_usage() == {"available": False}
    finally:
        restore()


def test_no_token_is_unavailable():
    restore, calls = _stub(PAYLOAD)
    try:
        usage._token = lambda _path: None
        assert usage.get_usage() == {"available": False}
        assert calls[0] == 0
    finally:
        restore()


# --- per-account usage (multi-account fallback ladder) -----------------------

def _stub_paths(by_token: dict):
    """Patch _token to derive a token from the credentials path, and _fetch to
    answer per token — so one stub can serve several accounts."""
    saved_token, saved_fetch = usage._token, usage._fetch
    calls = []

    def token(path):
        return f"tok:{path}"

    def fetch(tok):
        calls.append(tok)
        return by_token.get(tok)

    usage._token = token
    usage._fetch = fetch
    usage._cache.clear()
    return (lambda: (setattr(usage, "_token", saved_token),
                     setattr(usage, "_fetch", saved_fetch),
                     usage._cache.clear())), calls


def test_two_accounts_do_not_share_a_cache():
    """Slot 2's meter must never show slot 1's numbers — the ladder picks on it."""
    a, b = "/tmp/acct-a.json", "/tmp/acct-b.json"
    restore, calls = _stub_paths({
        f"tok:{a}": {"five_hour": {"utilization": 5, "resets_at": None},
                     "seven_day": None, "limits": []},
        f"tok:{b}": {"five_hour": {"utilization": 96, "resets_at": None},
                     "seven_day": None, "limits": []},
    })
    try:
        assert usage.get_usage(a)["five_hour"]["percent"] == 5
        assert usage.get_usage(b)["five_hour"]["percent"] == 96
        assert usage.get_usage(a)["five_hour"]["percent"] == 5   # still A's
        assert len(calls) == 2                                  # one fetch each
    finally:
        restore()


def test_one_accounts_failure_does_not_blank_another():
    a, b = "/tmp/acct-c.json", "/tmp/acct-d.json"
    restore, _ = _stub_paths({
        f"tok:{a}": {"five_hour": {"utilization": 11, "resets_at": None},
                     "seven_day": None, "limits": []},
    })                                     # b has no payload → fetch returns None
    try:
        assert usage.get_usage(a)["available"] is True
        assert usage.get_usage(b) == {"available": False}
        assert usage.get_usage(a)["five_hour"]["percent"] == 11
    finally:
        restore()


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
