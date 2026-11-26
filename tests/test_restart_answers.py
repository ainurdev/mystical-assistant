"""A restarted bridge answers the session list, the login meters and the update
check at once (speed-and-sentry ticket 03).

The session list and the meters are saved beside the DB as each is built or
read; a fresh process answers its first ask from that file, marked stale or
with the time it was read, while the real answer is built behind. "A fresh
process" is the module's start-up read of the file, redone here after writing
it, the way tests/test_toolsets.py resets toolsets._cache. /local/update reads
the checkout against the last fetch; the hourly watch is what fetches.
Run: python -m pytest tests/test_restart_answers.py -v
"""

import json
import os
import threading
import time

import pytest

from bridge import accounts, git, reports, selfupdate, store, usage, whatsnew
from bridge.dashboard import server

store.init()


def _handler():
    h = server.Handler.__new__(server.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _get(path, qs=None):
    h, box = _handler()
    h._get_api(path, qs or {})
    return box["obj"]


def _until(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


# --- the session list ---------------------------------------------------------

@pytest.fixture
def sessions(monkeypatch):
    """A scan that takes a while and lists whatever `rows` holds when it runs."""
    rows = {"n": ["old"]}
    scans = []

    def scan(chat, project):
        scans.append((chat, project))
        time.sleep(0.3)
        return {"sessions": [f"{chat}:{project}:{r}" for r in rows["n"]]}

    monkeypatch.setattr(server, "_sessions_payload", scan)
    monkeypatch.setattr(server, "_sessions_cache", {})
    monkeypatch.setattr(server, "_sessions_written", {})
    monkeypatch.setattr(server, "_sessions_disk", {})
    try:
        os.remove(server._sessions_file())
    except OSError:
        pass
    yield rows, scans
    assert _until(lambda: not server._sessions_behind)   # no build outlives its fakes


def _restart_sessions(monkeypatch):
    monkeypatch.setattr(server, "_sessions_cache", {})
    monkeypatch.setattr(server, "_sessions_boot", server._load_saved_sessions())
    monkeypatch.setattr(server, "_sessions_disk", dict(server._sessions_boot))


def test_a_restart_answers_the_first_session_list_from_the_last_run(sessions, monkeypatch):
    rows, scans = sessions
    first = _get("/local/sessions")                       # the last run's answer, saved
    assert "stale" not in first
    _restart_sessions(monkeypatch)
    rows["n"] = ["old", "new"]                            # started while the bridge was down
    scans.clear()

    t0 = time.time()
    got = _get("/local/sessions")
    assert time.time() - t0 < 0.1
    assert got == {**first, "stale": True}
    assert _until(lambda: scans)                          # the real list builds behind
    assert _until(lambda: "stale" not in _get("/local/sessions"))
    fresh = _get("/local/sessions")
    assert any(s.endswith(":new") for s in fresh["sessions"])
    assert len(scans) == 1


def test_each_chat_and_filter_gets_its_own_saved_list(sessions, monkeypatch):
    server._sessions_cached(1, None)
    server._sessions_cached(1, "proj")
    server._sessions_cached(2, None)
    _restart_sessions(monkeypatch)
    assert server._sessions_cached(1, None) == {"sessions": ["1:None:old"], "stale": True}
    assert server._sessions_cached(1, "proj") == {"sessions": ["1:proj:old"], "stale": True}
    assert server._sessions_cached(2, None) == {"sessions": ["2:None:old"], "stale": True}
    assert server._sessions_cached(3, None) == {"sessions": ["3:None:old"]}   # never saved: built now


@pytest.mark.parametrize("content", [None, "{not json", "[1, 2]", '{"x": 3}'])
def test_a_missing_or_garbled_saved_list_builds_as_today(sessions, monkeypatch, content):
    rows, scans = sessions
    if content is not None:
        with open(server._sessions_file(), "w") as f:
            f.write(content)
    _restart_sessions(monkeypatch)
    assert server._sessions_cached(1, None) == {"sessions": ["1:None:old"]}
    assert scans == [(1, None)]


def test_a_dashboard_change_never_brings_the_saved_list_back(sessions, monkeypatch):
    server._sessions_cached(1, None)
    _restart_sessions(monkeypatch)
    server._sessions_cache.clear()
    server._sessions_boot.clear()          # what a dashboard POST does
    assert "stale" not in server._sessions_cached(1, None)


# --- the login meters ---------------------------------------------------------

LOGINS = [{"slot": 1, "email": "a@x.com", "alias": None, "disabled": False, "default": True,
           "auto_switch": True, "order": 0},
          {"slot": 2, "email": "b@x.com", "alias": None, "disabled": False, "default": False,
           "auto_switch": True, "order": 1}]


def _reading(five, seven=10):
    return {"five_hour": {"utilization": five, "resets_at": "2026-11-23T20:00:00+00:00"},
            "seven_day": {"utilization": seven, "resets_at": "2026-11-28T20:00:00+00:00"}}


@pytest.fixture
def meters(monkeypatch):
    """Two logins whose reads go through a fake `claude`: `now` is what it answers."""
    now = {1: _reading(20), 2: _reading(5)}
    spawns = []
    paths = {accounts.credentials_path(a["slot"]): a["slot"] for a in LOGINS}

    def fetch(path):
        spawns.append(paths[path])
        time.sleep(0.3)
        return now[paths[path]]

    monkeypatch.setattr(accounts, "list_accounts", lambda: [dict(a) for a in LOGINS])
    monkeypatch.setattr(usage, "_fetch", fetch)
    monkeypatch.setattr(usage, "has_token", lambda path: True)
    monkeypatch.setattr(usage, "_cache", {})
    monkeypatch.setattr(usage, "_boot", {})
    try:
        os.remove(usage._saved_file())
    except OSError:
        pass
    yield now, spawns
    assert _until(lambda: not usage._behind)   # no read outlives its fakes


def _restart_meters(monkeypatch):
    monkeypatch.setattr(usage, "_cache", {})
    monkeypatch.setattr(usage, "_boot", usage._load_saved())


def _age(secs):
    """Every reading this process made, as if made `secs` earlier."""
    for e in usage._cache.values():
        e["ts"] -= secs


def test_saved_meters_answer_the_first_accounts_ask_at_once(meters, monkeypatch):
    now, spawns = meters
    before = {a["slot"]: a for a in _get("/local/accounts")["accounts"]}
    assert before[1]["five_hour"]["percent"] == 20 and before[1]["read_at"]
    _restart_meters(monkeypatch)
    now[1] = _reading(60)
    spawns.clear()

    t0 = time.time()
    got = {a["slot"]: a for a in _get("/local/accounts")["accounts"]}
    assert time.time() - t0 < 0.1
    assert got[1]["five_hour"]["percent"] == 20 and got[1]["left"] == 80
    assert got[1]["read_at"] == before[1]["read_at"]        # the time it was read, last run
    assert got[2]["five_hour"]["percent"] == 5
    assert _until(lambda: _get("/local/accounts")["accounts"][0]["five_hour"]["percent"] == 60)
    assert sorted(spawns) == [1, 2]


def test_an_expired_meter_answers_at_once_and_reads_behind(meters):
    # Sentry MYSTICAL-B: every 5 minutes the poll that found the meters expired
    # waited ~2 s on a `claude -p` per login.
    now, spawns = meters
    _get("/local/accounts")
    _age(usage.CACHE_TTL + 1)
    now[1] = _reading(60)
    spawns.clear()

    t0 = time.time()
    got = {a["slot"]: a for a in _get("/local/accounts")["accounts"]}
    assert time.time() - t0 < 0.1
    assert got[1]["five_hour"]["percent"] == 20 and got[1]["left"] == 80   # the reading it had
    assert _until(lambda: _get("/local/accounts")["accounts"][0]["five_hour"]["percent"] == 60)
    assert sorted(spawns) == [1, 2]                         # each login read once, behind


def test_the_usage_meter_answers_at_once_after_a_restart_and_once_expired(meters, monkeypatch):
    # Sentry MYSTICAL-A: /local/usage waited on the spawn at every start and every 5 minutes.
    now, spawns = meters
    # /local/usage is login 1's meter (test_accounts leaves accounts.CLAUDE_HOME repointed, so say so here)
    monkeypatch.setattr(usage, "CREDENTIALS_FILE", accounts.credentials_path(1))
    assert _get("/local/usage")["five_hour"]["percent"] == 20
    _restart_meters(monkeypatch)
    now[1] = _reading(40)

    t0 = time.time()
    assert _get("/local/usage")["five_hour"]["percent"] == 20       # the last run's
    assert time.time() - t0 < 0.1
    assert _until(lambda: _get("/local/usage")["five_hour"]["percent"] == 40)

    _age(usage.CACHE_TTL + 1)
    now[1] = _reading(70)
    t0 = time.time()
    assert _get("/local/usage")["five_hour"]["percent"] == 40       # the one it had
    assert time.time() - t0 < 0.1
    assert _until(lambda: _get("/local/usage")["five_hour"]["percent"] == 70)


def test_a_meter_past_stale_max_is_read_anew_not_shown(meters, monkeypatch):
    # Nothing reads a meter while no screen looks, so the bot's /accounts (no age
    # shown) put a 5 h old reading up as current.
    now, spawns = meters
    _get("/local/accounts")
    _age(usage.STALE_MAX + 1)
    now[1] = _reading(60)
    assert _get("/local/accounts")["accounts"][0]["five_hour"]["percent"] == 60

    _restart_meters(monkeypatch)
    for hit in usage._boot.values():
        hit["ts"] -= usage.STALE_MAX + 1
    now[1] = _reading(70)
    assert _get("/local/accounts")["accounts"][0]["five_hour"]["percent"] == 70


def test_a_meter_that_cannot_be_read_holds_only_its_first_ask(meters):
    # Sentry MYSTICAL-A and -B on a teammate's install: a login with no readable meter
    # was read again inside the poll at every retry, 1.3 to 2.6 s each, for hours.
    now, spawns = meters

    def retry_due():
        for e in usage._cache.values():
            e["next_try"] = e["next_try"] and time.time() - 1
        spawns.clear()

    now[2] = None                                           # signed out, or a login with no plan
    _get("/local/accounts")
    retry_due()
    t0 = time.time()
    got = {a["slot"]: a for a in _get("/local/accounts")["accounts"]}
    assert time.time() - t0 < 0.1
    assert got[2]["five_hour"] is None and got[1]["five_hour"]["percent"] == 20
    assert _until(lambda: spawns == [2])                    # read again, behind
    assert _until(lambda: not usage._behind)

    now[1] = None                                           # login 1's reads fail from here on
    _age(usage.STALE_MAX + 1)
    _get("/local/accounts")                                 # past STALE_MAX: read anew, in the ask
    retry_due()
    t0 = time.time()
    got = {a["slot"]: a for a in _get("/local/accounts")["accounts"]}
    assert time.time() - t0 < 0.1
    assert got[1]["five_hour"] is None                      # too old to show, and said so at once
    assert _until(lambda: sorted(spawns) == [1, 2])


def test_a_failed_read_shows_one_meter_waiting_and_retrying(meters):
    # A login a turn reported on, whose reads then fail: the ask that finds the retry due
    # shows what the asks between retries show, so the meter never flips from poll to poll.
    now, spawns = meters
    _get("/local/accounts")
    path = accounts.credentials_path(1)
    usage.note_event(path, {"rateLimitType": "five_hour", "utilization": 0.2, "status": "allowed"})
    now[1] = None
    _age(usage.STALE_MAX + 1)
    usage._cache[path]["live_at"] -= usage.STALE_MAX + 1
    waiting = _get("/local/accounts")["accounts"][0]["five_hour"]    # read anew in the ask: it fails
    usage._cache[path]["next_try"] = time.time() - 1                 # the retry is due
    assert _get("/local/accounts")["accounts"][0]["five_hour"] == waiting


def test_a_meter_read_inside_the_ask_is_not_the_bridges_own_time(meters, monkeypatch):
    # The first read of a login, and one past STALE_MAX, wait on `claude -p` by design
    # (0.7 to 2.6 s): reports.outside takes that wait out of the request's time.
    monkeypatch.setattr(usage, "CREDENTIALS_FILE", accounts.credentials_path(1))
    reports.take_outside()
    _get("/local/usage")                                    # login 1, read in the ask: the fake takes 0.3 s
    assert reports.take_outside() >= 0.3
    _get("/local/accounts")                                 # login 2, read on the pool's thread
    assert reports.take_outside() >= 0.3
    _get("/local/accounts")                                 # nothing left to read
    assert reports.take_outside() < 0.1


def test_picking_an_account_reads_an_expired_meter_anew(meters):
    now, spawns = meters
    _get("/local/accounts")                                 # login 1 has room
    _age(usage.CACHE_TTL + 1)
    now[1] = _reading(100, 100)                             # it ran out since
    assert accounts.pick(auto_switch=True) == 2


def test_picking_an_account_never_uses_a_saved_meter(meters, monkeypatch):
    now, spawns = meters
    _get("/local/accounts")                                 # saved: login 2 has room
    _restart_meters(monkeypatch)
    now[2] = _reading(100, 100)                             # it ran out since
    now[1] = _reading(50)
    assert accounts.pick(auto_switch=True) == 1


@pytest.mark.parametrize("content", [None, "{not json", "[1]", '{"p": 3}', '{"p": {"ts": "x"}}'])
def test_a_missing_or_garbled_saved_meter_reads_as_today(meters, monkeypatch, content):
    now, spawns = meters
    if content is not None:
        with open(usage._saved_file(), "w") as f:
            f.write(content)
    _restart_meters(monkeypatch)
    got = {a["slot"]: a for a in _get("/local/accounts")["accounts"]}
    assert got[1]["five_hour"]["percent"] == 20
    assert sorted(spawns) == [1, 2]


def test_the_saved_meter_file_keeps_each_logins_last_good_reading(meters, monkeypatch):
    now, spawns = meters
    _get("/local/accounts")
    with open(usage._saved_file()) as f:
        saved = json.load(f)
    assert {p: e["data"]["five_hour"]["percent"] for p, e in saved.items()} == {
        accounts.credentials_path(1): 20, accounts.credentials_path(2): 5}
    assert all(e["ts"] > 0 for e in saved.values())


# --- the update check ---------------------------------------------------------

def test_the_update_check_never_waits_on_a_fetch(monkeypatch):
    hung = threading.Event()
    monkeypatch.setattr(git, "fetch", lambda *a, **k: hung.wait(10))
    monkeypatch.setattr(whatsnew, "preview", lambda info: None)
    t0 = time.time()
    try:
        got = _get("/local/update")
    finally:
        hung.set()
    assert time.time() - t0 < 1.0
    assert "behind" in got


def test_the_hourly_watch_fetches_first_at_five_minutes(monkeypatch):
    waits, fetched = [], threading.Event()

    def sleep(s):
        waits.append(s)
        if len(waits) > 1:
            threading.Event().wait()   # parked for good: it never runs past its fakes

    monkeypatch.setattr(whatsnew, "time", type("T", (), {"sleep": staticmethod(sleep), "time": time.time}))
    monkeypatch.setattr(git, "fetch", lambda *a, **k: fetched.set() or (True, ""))
    monkeypatch.setattr(whatsnew, "preview", lambda info: None)
    monkeypatch.setattr(whatsnew, "retry", lambda: None)
    whatsnew.watch()
    assert fetched.wait(5)
    assert waits[0] == 300
    assert _until(lambda: len(waits) == 2)     # parked before the fakes are undone


def test_update_still_pulls(monkeypatch):
    calls = []
    monkeypatch.setattr(git, "pull", lambda repo, *a, **k: calls.append(repo) or (False, "refused"))
    ok, _, pulled = selfupdate.update()
    assert calls == [selfupdate.REPO] and not ok and not pulled
