"""The Live board's usage footer (bridge/tgboard.py, ticket telegram-widgets 07): both
windows of the right login, from the meter's cached reading only."""

import json
import time
import uuid

import pytest

from bridge import accounts, config, experimental, machine, runner, state, store, telegram, tgboard, usage

store.init()
CHAT = config.DASH_CHAT_ID
NOW = 1794300000.0
FIVE = "2026-11-11T18:00:00+00:00"
WEEK = "2026-11-15T09:00:00+00:00"


@pytest.fixture
def tg(monkeypatch):
    calls = []
    mids = iter(range(900, 10_000))

    def fake(method, **params):
        calls.append((method, params))
        return {"message_id": next(mids)} if method == "sendWidget" else True
    monkeypatch.setattr(telegram, "tg", fake)
    monkeypatch.setattr(experimental, "enabled", lambda: True)
    monkeypatch.setattr(machine, "live_session_ids", lambda: set())
    monkeypatch.setattr(state, "miniapp_url", "https://mini.example")
    monkeypatch.setattr(usage, "_cache", {})
    monkeypatch.setattr(usage, "_fetch", lambda path: pytest.fail("the board forced a fresh reading"))
    monkeypatch.setattr(accounts, "_load", lambda: {})
    store.set_setting(tgboard.KEY, None)
    tgboard._seen.clear()
    tgboard._sent.clear()
    runner._jobs.clear()
    yield calls
    runner._jobs.clear()


def reading(slot=None, five=(42, FIVE, "normal"), week=(61, WEEK, "warning")):
    e = usage._entry(accounts.credentials_path(slot))
    e.update(ts=time.time(), data={"available": True, "limits": [],
                           "five_hour": five and dict(zip(("percent", "resets_at", "severity"), five)),
                           "seven_day": week and dict(zip(("percent", "resets_at", "severity"), week))})


def turn(title="Fix login", *, started=NOW - 60, slot=None):
    sess = store.create_session(CHAT, "proj")
    with store.closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=? WHERE id=?", (title, sess["id"]))
    job = runner.Job(uuid.uuid4().hex, CHAT, sess["id"])
    job.started = started
    job.account_slot = slot
    runner._jobs[job.id] = job
    return sess["id"], job


def sent(calls):
    return [json.loads(p["chat_data"]) for m, p in calls if m in ("sendWidget", "editMessageWidgetData")]


def epoch(iso):
    return int(usage.resets_epoch(iso))


def test_the_footer_carries_both_windows_percent_reset_and_severity(tg):
    reading()
    turn()
    tgboard.look(NOW)
    assert sent(tg)[-1]["u"] == {"w": [[42, epoch(FIVE), 0], [61, epoch(WEEK), 1]]}


def test_it_is_the_most_recently_started_running_turns_login(tg, monkeypatch):
    monkeypatch.setattr(accounts, "_load", lambda: {"2": {"alias": "work"}, "3": {"email": "b@x.io"}})
    reading(2, five=(10, FIVE, "normal"))
    reading(3, five=(97, FIVE, "exceeded"))
    turn("older", started=NOW - 600, slot=2)
    turn("newer", started=NOW - 60, slot=3)
    tgboard.look(NOW)
    assert sent(tg)[-1]["u"] == {"l": "b@x.io", "w": [[97, epoch(FIVE), 2], [61, epoch(WEEK), 1]]}


def test_with_nothing_running_it_is_the_default_login(tg, monkeypatch):
    monkeypatch.setattr(accounts, "_load", lambda: {"2": {"alias": "work"}})
    monkeypatch.setattr(accounts, "_email_at", lambda path: "me@x.io")
    reading()
    reading(2, five=(5, FIVE, "normal"))
    assert tgboard.footer([]) == {"l": "me@x.io", "w": [[42, epoch(FIVE), 0], [61, epoch(WEEK), 1]]}


def test_one_login_is_not_named(tg):
    reading()
    assert "l" not in tgboard.footer([])


def test_no_reading_no_footer(tg):
    turn()
    tgboard.look(NOW)
    assert "u" not in sent(tg)[-1]
    assert tgboard.footer([]) is None


def test_a_reading_past_its_stale_limit_is_no_reading(tg):
    reading()
    usage._entry(accounts.credentials_path(None))["ts"] = time.time() - usage.STALE_MAX - 1
    assert tgboard.footer([]) is None


def test_a_missing_window_is_null(tg):
    reading(week=None)
    assert tgboard.footer([])["w"] == [[42, epoch(FIVE), 0], None]


def test_a_changed_reading_is_one_data_edit(tg):
    reading()
    turn()
    tgboard.look(NOW)
    tgboard.look(NOW + 5)
    assert len(sent(tg)) == 1                     # nothing changed: no edit
    reading(five=(55, FIVE, "normal"))
    tgboard.look(NOW + 10)
    edits = [m for m, _ in tg if m == "editMessageWidgetData"]
    assert len(edits) == 1 and sent(tg)[-1]["u"]["w"][0][0] == 55


def test_seven_full_rows_and_the_footer_fit_and_rows_go_when_they_dont():
    rows = [{"sid": uuid.uuid4().hex, "c": "r", "t": "界" * 20, "s": "界" * 20, "a": NOW - i, "n": "999.9k"}
            for i in range(9)]
    u = {"l": "someone.long@example.com", "w": [[100, int(NOW), 2], [100, int(NOW), 2]]}
    d = tgboard.data(rows, NOW, u)
    assert d["u"] == u and len(d["rows"]) == 7 and d["more"] == 2
    assert len(tgboard.dump(d).encode()) <= tgboard.DATA_MAX
    big = {**u, "l": "x" * 400}                   # only a footer this size squeezes rows out
    d = tgboard.data(rows, NOW, big)
    assert len(tgboard.dump(d).encode()) <= tgboard.DATA_MAX and len(d["rows"]) < 7
