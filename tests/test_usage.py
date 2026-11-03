"""Unit tests for the usage cache (bridge/usage.py).
Run directly: `python tests/test_usage.py` (or with pytest).

The meter reads Claude Code's get_usage, and a failed read keeps serving the
last good payload instead of blanking the meters. A running turn's
rate_limit_event fills it in live between reads.
"""

import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import usage  # noqa: E402

PAYLOAD = {"five_hour": {"utilization": 7, "resets_at": "2026-07-30T10:00:00+00:00"},
           "seven_day": {"utilization": 13, "resets_at": "2026-08-05T12:00:00+00:00"},
           "limits": [{"kind": "session", "group": "session", "severity": "normal"}]}


def _stub(*fetches):
    """Patch _fetch; it returns each item in turn (None = failure).
    Returns (restore, calls) where calls[0] counts fetch attempts."""
    saved_token, saved_fetch = usage._token, usage._fetch
    seq, calls = list(fetches), [0]

    def fetch(_path):
        calls[0] += 1
        return seq.pop(0) if seq else None

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
        assert usage.get_usage() == first      # served from cache
        assert calls[0] == 1
        assert first["live"] is False and first["read_at"]
    finally:
        restore()


def test_scoped_limit_keeps_its_model():
    """A weekly_scoped limit is only useful with its scope — that is what names
    the model (e.g. Fable) whose own weekly cap it is."""
    scoped = {"kind": "weekly_scoped", "group": "weekly", "percent": 40,
              "severity": "normal", "resets_at": "2026-08-05T12:00:00+00:00",
              "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None},
              "is_active": False}
    restore, _ = _stub({**PAYLOAD, "limits": [*PAYLOAD["limits"], scoped]})
    try:
        limits = usage.get_usage()["limits"]
        assert limits[1]["scope"] == scoped["scope"]
        assert limits[0]["scope"] is None          # unscoped rows say so
    finally:
        restore()


def test_failure_serves_last_good():
    restore, calls = _stub(PAYLOAD, None)
    try:
        good = usage.get_usage()
        _default_entry()["ts"] = time.time() - usage.CACHE_TTL - 1   # cache expired
        again = usage.get_usage()              # a failed read doesn't blank the meter
        assert again["five_hour"] == good["five_hour"] and again["seven_day"] == good["seven_day"]
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


def test_reading_never_touches_the_token():
    """The CLI reads the plan and renews its own token: an idle login whose
    access token lapsed still gets a number, and the bridge never holds one."""
    restore, calls = _stub(PAYLOAD)
    try:
        def boom(_path):
            raise AssertionError("the meter read a token")
        usage._token = boom
        assert usage.get_usage()["five_hour"]["percent"] == 7
        assert calls[0] == 1
    finally:
        restore()


class _Ran:
    def __init__(self, stdout):
        self.stdout = stdout


def _fake_run(reply, seen):
    import json as _json
    def run(argv, **kw):
        seen.append((argv, kw))
        return _Ran("\n".join(_json.dumps(x) for x in reply))
    return run


def test_fetch_asks_claude_for_get_usage_on_that_login():
    import json as _json
    saved = usage.subprocess.run
    seen = []
    ok = {"type": "control_response", "response": {"subtype": "success", "request_id": "usage",
          "response": {"rate_limits_available": True, "rate_limits": PAYLOAD}}}
    usage.subprocess.run = _fake_run([{"type": "system", "subtype": "hook_started"}, ok], seen)
    try:
        assert usage._fetch(usage.CREDENTIALS_FILE) == PAYLOAD
        argv, kw = seen[0]
        assert argv[1] == "-p" and "stream-json" in argv
        req = _json.loads(kw["input"])
        assert req["request"] == {"subtype": "get_usage", "skip_behaviors": True}
        assert "CLAUDE_CONFIG_DIR" not in kw["env"]          # the ambient login
        usage._fetch("/tmp/profiles/2/.credentials.json")
        assert seen[1][1]["env"]["CLAUDE_CONFIG_DIR"] == "/tmp/profiles/2"
    finally:
        usage.subprocess.run = saved


def test_fetch_without_plan_limits_is_none():
    saved = usage.subprocess.run
    no = {"type": "control_response", "response": {"subtype": "success", "request_id": "usage",
          "response": {"rate_limits_available": False, "rate_limits": None}}}
    usage.subprocess.run = _fake_run([no], [])
    try:
        assert usage._fetch(usage.CREDENTIALS_FILE) is None
    finally:
        usage.subprocess.run = saved


def test_a_turns_rate_limit_event_is_a_live_reading():
    restore, calls = _stub(None)
    try:
        usage.note_event(None, {"status": "allowed_warning", "unifiedWindows": {
            "seven_day": {"utilization": 0.91, "resetsAt": 1793793600, "status": "allowed_warning"}}})
        m = usage.get_usage()
        assert m["seven_day"]["percent"] == 91 and m["seven_day"]["severity"] == "warning"
        assert m["seven_day"]["resets_at"].startswith("2026-11-04")
        assert m["live"] is True and m["status"] == "allowed_warning"
    finally:
        restore()


def test_a_newer_read_outranks_the_events_word():
    restore, _ = _stub(PAYLOAD)
    try:
        usage.note_event(None, {"status": "allowed_warning", "unifiedWindows": {
            "five_hour": {"utilization": 0.95, "status": "allowed_warning"}}})
        assert usage.get_usage(max_age=3600)["status"] == "allowed_warning"
        m = usage.get_usage(max_age=0)                 # a fresh read lands after it
        assert m["status"] is None and m["five_hour"]["percent"] == 7 and m["live"] is True
    finally:
        restore()


def test_max_age_zero_reads_now():
    restore, calls = _stub(PAYLOAD, PAYLOAD)
    try:
        usage.get_usage()
        usage.get_usage(max_age=0)
        assert calls[0] == 2
    finally:
        restore()


def test_an_idle_login_that_can_renew_its_token_is_still_logged_in():
    """Only the access token lapses on an idle login: claude renews it from the
    refresh token on its next run. Without either, the login has to be redone."""
    saved = usage.credentials.load
    past = (time.time() - 3600) * 1000
    try:
        usage.credentials.load = lambda _p: {"claudeAiOauth": {
            "accessToken": "a", "refreshToken": "r", "expiresAt": past}}
        assert usage.has_token("x")
        usage.credentials.load = lambda _p: {"claudeAiOauth": {"accessToken": "a", "expiresAt": past}}
        assert not usage.has_token("x")
        usage.credentials.load = lambda _p: {"claudeAiOauth": {"accessToken": "a"}}
        assert usage.has_token("x")                   # a token that never expires
        usage.credentials.load = lambda _p: {}
        assert not usage.has_token("x")
    finally:
        usage.credentials.load = saved


# --- per-account usage (multi-account fallback ladder) -----------------------

def _stub_paths(by_path: dict):
    """Patch _fetch to answer per credentials path, so one stub can serve
    several accounts."""
    saved_token, saved_fetch = usage._token, usage._fetch
    calls = []

    def fetch(path):
        calls.append(path)
        return by_path.get(path)

    usage._fetch = fetch
    usage._cache.clear()
    return (lambda: (setattr(usage, "_token", saved_token),
                     setattr(usage, "_fetch", saved_fetch),
                     usage._cache.clear())), calls


def test_two_accounts_do_not_share_a_cache():
    """Slot 2's meter must never show slot 1's numbers — the ladder picks on it."""
    a, b = "/tmp/acct-a.json", "/tmp/acct-b.json"
    restore, calls = _stub_paths({
        a: {"five_hour": {"utilization": 5, "resets_at": None},
                     "seven_day": None, "limits": []},
        b: {"five_hour": {"utilization": 96, "resets_at": None},
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
        a: {"five_hour": {"utilization": 11, "resets_at": None},
                     "seven_day": None, "limits": []},
    })                                     # b has no payload → fetch returns None
    try:
        assert usage.get_usage(a)["available"] is True
        assert usage.get_usage(b) == {"available": False}
        assert usage.get_usage(a)["five_hour"]["percent"] == 11
    finally:
        restore()


REFILL = 10_000.0 + 3 * 3600   # the 5-hour window refills three hours after t=10000


def _read(e: dict, t: float, u: float, refill: float = REFILL) -> None:
    iso = datetime.fromtimestamp(refill, timezone.utc).isoformat()
    usage._remember(e, t, {"five_hour": {"utilization": u, "resets_at": iso}})


def test_pace_projects_the_hours_rate_to_the_limit():
    e = {}
    _read(e, 10_000, 40)
    _read(e, 10_600, 45)
    _read(e, 11_200, 50)               # 10 points in 20 minutes: 50 more take 100
    out = usage._pace(e["hist"], 11_200)
    assert datetime.fromisoformat(out).timestamp() == 11_200 + 100 * 60


def test_no_pace_when_it_refills_first_or_there_is_too_little_to_tell():
    e = {}
    _read(e, 10_000, 40)
    _read(e, 10_300, 41)
    assert usage._pace(e["hist"], 10_300) is None       # five minutes is noise
    _read(e, 11_200, 42)                                # 2 points in 20 min: 9h away
    assert usage._pace(e["hist"], 11_200) is None       # it refills long before
    flat = {}
    _read(flat, 10_000, 40)
    _read(flat, 11_200, 40)
    assert usage._pace(flat["hist"], 11_200) is None    # not climbing


def test_pace_forgets_another_window_and_the_hour_before():
    e = {}
    _read(e, 10_000, 90, refill=10_500)                  # the window before
    _read(e, 11_000, 5)                                  # it rolled: 90 is gone
    assert [h[1] for h in e["hist"]] == [5.0]
    _read(e, 11_000 + 3700, 30)                          # over an hour on
    assert [h[1] for h in e["hist"]] == [30.0]


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
