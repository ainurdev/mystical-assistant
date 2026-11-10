"""The Live board through a restart, a deletion and Telegram's refusals
(bridge/tgboard.py, ticket telegram-widgets 03). Same recorder as test_tgboard, which
can answer a method with a refusal: None plus the description telegram.tg records."""

import json
import threading
import uuid

import pytest

from bridge import config, experimental, machine, runner, state, store, telegram, tgboard

store.init()
CHAT = config.DASH_CHAT_ID
NOW = 1794300000.0
GONE = "Bad Request: message with widget to edit not found"


class Calls(list):
    refuse: dict


@pytest.fixture
def tg(monkeypatch):
    """Every Bot API call, recorded. refuse[method] = description makes that method fail."""
    calls, refuse = Calls(), {}
    mids = iter(range(900, 10_000))

    def fake(method, **params):
        calls.append((method, params))
        telegram._last.error = refuse.get(method, "")
        if method in refuse:
            return None
        return {"message_id": next(mids)} if method == "sendWidget" else True
    monkeypatch.setattr(telegram, "tg", fake)
    monkeypatch.setattr(experimental, "enabled", lambda: True)
    monkeypatch.setattr(machine, "live_session_ids", lambda: set())
    monkeypatch.setattr(state, "miniapp_url", "https://mini.example")
    store.set_setting(tgboard.KEY, None)
    tgboard._seen.clear()
    tgboard._sent.clear()
    tgboard._wait[0] = 0
    runner._jobs.clear()
    calls.refuse = refuse
    yield calls
    runner._jobs.clear()


def turn(title="Fix login", *, started=NOW - 60, step="Bash: ls"):
    sess = store.create_session(CHAT, "proj")
    with store.closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=? WHERE id=?", (title, sess["id"]))
    job = runner.Job(uuid.uuid4().hex, CHAT, sess["id"])
    job.started = started
    job.events.append({"type": "tool", "name": step})
    runner._jobs[job.id] = job
    return sess["id"], job


def methods(calls):
    return [m for m, _ in calls]


def restart():
    """What a restart loses: everything in memory. The settings record stays."""
    tgboard._seen.clear()
    tgboard._sent.clear()
    tgboard._wait[0] = 0


def test_after_a_restart_the_recorded_board_is_edited_whole_and_nothing_is_sent(tg, monkeypatch):
    turn()
    tgboard.look(NOW)
    tg.clear()
    restart()
    monkeypatch.setattr(state, "miniapp_url", "https://moved.example")
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData", "editMessageCaption"]
    assert all(p["message_id"] == 900 for _, p in tg)
    assert tg[1][1]["caption"] == "1 running" and "moved.example" in tg[1][1]["reply_markup"]


def test_turns_resumed_at_boot_with_no_board_send_one(tg):
    turn("a")
    turn("b")
    tgboard.look(NOW)
    assert methods(tg) == ["sendWidget", "pinChatMessage"]


@pytest.mark.parametrize("gone", [GONE, "Bad Request: message to edit not found"])
def test_a_deleted_board_stays_deleted_until_the_next_turn_starts(tg, gone):
    _, job = turn()
    tgboard.look(NOW)
    tg.clear()
    tg.refuse["editMessageWidgetData"] = gone
    job.events.append({"type": "tool", "name": "Read"})
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData"]
    assert tgboard.record()["board"] is None
    tg.clear()
    tg.refuse.clear()
    for t in (10, 15, 75):
        tgboard.look(NOW + t)
    assert tg == []
    turn("new", started=NOW + 80)
    tgboard.look(NOW + 80)
    assert methods(tg) == ["sendWidget", "pinChatMessage"]
    assert tgboard.record()["board"]["msg"] == 901


def test_a_gone_caption_edit_also_clears_the_record(tg, monkeypatch):
    turn()
    tgboard.look(NOW)
    tg.refuse["editMessageCaption"] = "Bad Request: message to edit not found"
    monkeypatch.setattr(state, "miniapp_url", "https://moved.example")
    tgboard.look(NOW + 5)
    assert tgboard.record()["board"] is None


def test_not_modified_is_success_and_is_not_tried_again(tg):
    _, job = turn()
    tgboard.look(NOW)
    tg.clear()
    tg.refuse["editMessageWidgetData"] = "Bad Request: message is not modified"
    job.events.append({"type": "tool", "name": "Read"})
    tgboard.look(NOW + 5)
    tgboard.look(NOW + 10)
    assert methods(tg) == ["editMessageWidgetData"]
    assert tgboard.record()["board"]["msg"] == 900


def test_a_flood_refusal_is_waited_out(tg):
    _, job = turn()
    tgboard.look(NOW)
    tg.clear()
    tg.refuse["editMessageWidgetData"] = "Too Many Requests: retry after 17"
    job.events.append({"type": "tool", "name": "Read"})
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData"]
    tg.clear()
    tg.refuse.clear()
    turn("new", started=NOW + 10)
    for t in (10, 15, 21):
        tgboard.look(NOW + t)
    assert tg == []
    tgboard.look(NOW + 22)
    assert methods(tg) == ["editMessageWidgetData", "editMessageCaption"]


def test_a_flood_refused_send_is_waited_out_too(tg):
    tg.refuse["sendWidget"] = "Too Many Requests: retry after 30"
    turn()
    tgboard.look(NOW)
    tg.clear()
    tg.refuse.clear()
    turn("b", started=NOW + 5)
    tgboard.look(NOW + 5)
    assert tg == []


def test_any_other_refusal_is_tried_again_on_a_later_look(tg):
    _, job = turn()
    tgboard.look(NOW)
    tg.clear()
    tg.refuse["editMessageWidgetData"] = "Bad Request: something new"
    job.events.append({"type": "tool", "name": "Read"})
    tgboard.look(NOW + 5)
    tg.refuse.clear()
    tgboard.look(NOW + 10)
    assert methods(tg) == ["editMessageWidgetData", "editMessageWidgetData"]
    assert tgboard.record()["board"]["msg"] == 900


def test_neither_a_refusal_nor_an_exception_ends_the_watcher(monkeypatch):
    looks, parked = [], threading.Event()

    def look():
        looks.append(1)
        if len(looks) == 1:
            raise RuntimeError("boom")
        parked.set()
        threading.Event().wait()          # stay parked: no real look runs during later tests
    monkeypatch.setattr(tgboard, "look", look)
    monkeypatch.setattr(tgboard, "LOOK_S", 0)
    tgboard.watch()
    assert parked.wait(5) and len(looks) == 2


def test_with_notifications_off_no_board_appears_by_itself(tg, monkeypatch):
    monkeypatch.setattr(config, "NOTIFY_ENABLE", False)
    turn()
    tgboard.look(NOW)
    assert tg == []


def test_with_notifications_off_a_recorded_board_is_kept_up_to_date(tg, monkeypatch):
    _, job = turn()
    tgboard.look(NOW)
    tg.clear()
    monkeypatch.setattr(config, "NOTIFY_ENABLE", False)
    job.events.append({"type": "tool", "name": "Read"})
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData"]
