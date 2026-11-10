"""/status brings a fresh Live board, and a board left behind says so: replaced by
/status or by a page version change, or switched off (bridge/tgboard.py, ticket
telegram-widgets 06). Same recorder as test_tgboard_refusals."""

import json
import uuid

import pytest

from bridge import config, dispatch, experimental, machine, runner, state, store, telegram, tgboard

store.init()
CHAT = config.DASH_CHAT_ID
NOW = 1794300000.0
DAY = 24 * 3600


class Calls(list):
    refuse: dict
    texts: list


@pytest.fixture
def tg(monkeypatch):
    """Every Bot API call, recorded; refuse[method] = description makes that method
    fail. texts: what telegram.send answered (today's /status text)."""
    calls, refuse, texts = Calls(), {}, []
    mids = iter(range(900, 10_000))
    switch = [True]

    def fake(method, **params):
        calls.append((method, params))
        telegram._last.error = refuse.get(method, "")
        if method in refuse:
            return None
        return {"message_id": next(mids)} if method == "sendWidget" else True
    monkeypatch.setattr(telegram, "tg", fake)
    monkeypatch.setattr(dispatch, "send", lambda chat, text, *a, **k: texts.append((chat, text)))
    monkeypatch.setattr(experimental, "enabled", lambda: switch[0])
    monkeypatch.setattr(machine, "live_session_ids", lambda: set())
    monkeypatch.setattr(state, "miniapp_url", "https://mini.example")
    monkeypatch.setattr(tgboard.time, "time", lambda: NOW)
    store.set_setting(tgboard.KEY, None)
    tgboard._seen.clear()
    tgboard._sent.clear()
    tgboard._wait[0] = 0
    tgboard._off[0] = False
    runner._jobs.clear()
    calls.refuse, calls.texts, calls.switch = refuse, texts, switch
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


def status(chat=CHAT, kind="private", user=None):
    dispatch.on_message({"chat": {"id": chat, "type": kind}, "from": {"id": user or chat},
                         "message_id": 5, "text": "/status"})


def board_at(at, v=tgboard.PAGE_V, msg=800):
    store.set_setting(tgboard.KEY, json.dumps({"board": {"chat": CHAT, "msg": msg, "at": int(at), "v": v}, "cards": {}}))


def data_of(call):
    return json.loads(call[1]["chat_data"])


def test_status_sends_a_fresh_board_silently_pins_it_and_deletes_the_old_one(tg):
    turn()
    board_at(NOW - 3600)
    status()
    assert methods(tg)[:3] == ["sendWidget", "pinChatMessage", "deleteMessage"]
    send = tg[0][1]
    assert send["chat_id"] == CHAT and send["disable_notification"] == "true" and send["allow_queries"] == "true"
    assert tg[1][1]["message_id"] == 900 and tg[2][1]["message_id"] == 800
    assert tgboard.record()["board"]["msg"] == 900
    assert tg.texts == []


def test_a_look_follows_status_at_once(tg, monkeypatch):
    looks = []
    real = tgboard.look
    monkeypatch.setattr(tgboard, "look", lambda now=None: (looks.append(now), real(now)))
    turn()
    status()
    assert looks == [NOW]
    assert methods(tg) == ["sendWidget", "pinChatMessage"]   # the look found nothing left to send


def test_status_with_no_board_recorded_just_sends_one(tg):
    status()
    assert methods(tg) == ["sendWidget", "pinChatMessage"]
    assert tg[0][1]["caption"] == "nothing running"


@pytest.mark.parametrize("age, refuse", [(2 * DAY + 60, None), (3600, "Bad Request: message can't be deleted")])
def test_an_old_board_that_wont_go_is_marked_moved_and_unpinned_once(tg, age, refuse):
    if refuse:
        tg.refuse["deleteMessage"] = refuse
    board_at(NOW - age)
    status()
    old = [(m, p) for m, p in tg if p.get("message_id") == 800]
    assert [m for m, _ in old] == (["deleteMessage"] if refuse else []) + ["editMessageWidgetData", "unpinChatMessage"]
    assert data_of([c for c in old if c[0] == "editMessageWidgetData"][0]) == {"v": tgboard.PAGE_V, "at": int(NOW), "left": "moved"}
    tg.clear()
    turn()
    for t in (5, 10, 70):
        tgboard.look(NOW + t)
    assert all(p.get("message_id") != 800 for _, p in tg)


def test_with_notifications_off_status_still_brings_a_board_that_keeps_up(tg, monkeypatch):
    monkeypatch.setattr(config, "NOTIFY_ENABLE", False)
    _, job = turn()
    status()
    assert methods(tg) == ["sendWidget", "pinChatMessage"]
    tg.clear()
    job.events.append({"type": "tool", "name": "Read"})
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData"]


def _today(tg):
    assert len(tg.texts) == 1 and tg.texts[0][1].startswith("Project: ")
    assert "Server: " in tg.texts[0][1]


def test_switch_off_answers_today_s_text_with_no_widget_call(tg):
    tg.switch[0] = False
    status()
    _today(tg)
    assert tg == []


def test_a_group_answers_today_s_text(tg):
    status(kind="group")
    _today(tg)
    assert "sendWidget" not in methods(tg)


def test_a_chat_that_is_not_the_owner_s_answers_today_s_text(tg, monkeypatch):
    other = CHAT + 1
    monkeypatch.setattr(config, "ALLOWED_CHAT_IDS", list(config.ALLOWED_CHAT_IDS) + [other])
    status(chat=other)
    _today(tg)
    assert "sendWidget" not in methods(tg)


def test_a_refused_widget_answers_today_s_text_and_keeps_the_old_board(tg):
    tg.refuse["sendWidget"] = "Bad Request: widgets are not supported"
    board_at(NOW - 3600)
    status()
    _today(tg)
    assert methods(tg) == ["sendWidget"]
    assert tgboard.record()["board"]["msg"] == 800


def test_switching_off_marks_the_board_off_unpins_it_and_stops(tg):
    turn()
    tgboard.look(NOW)
    tg.clear()
    tg.switch[0] = False
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData", "unpinChatMessage"]
    assert all(p["message_id"] == 900 for _, p in tg)
    assert data_of(tg[0]) == {"v": tgboard.PAGE_V, "at": int(NOW + 5), "left": "off"}
    assert tgboard.record()["board"] is None
    tg.clear()
    turn("new", started=NOW + 8)
    for t in (10, 15, 75):
        tgboard.look(NOW + t)
    assert tg == []


def test_switch_off_with_no_board_makes_no_call(tg):
    tg.switch[0] = False
    turn()
    tgboard.look(NOW)
    tgboard.look(NOW + 5)
    assert tg == []


def test_an_old_page_version_is_replaced_at_the_next_turn_start_and_never_fed(tg):
    _, job = turn()
    board_at(NOW - 3600, v=tgboard.PAGE_V - 1)
    tgboard._seen.update(r["sid"] for r in tgboard.rows(CHAT))   # already running at the last look
    job.events.append({"type": "tool", "name": "Read"})
    tgboard.look(NOW)
    tgboard.look(NOW + 70)
    assert tg == []                                              # no data its page can't read
    turn("new", started=NOW + 75)
    tgboard.look(NOW + 75)
    assert methods(tg) == ["sendWidget", "pinChatMessage", "deleteMessage"]
    assert tg[2][1]["message_id"] == 800
    assert tgboard.record()["board"] == {"chat": CHAT, "msg": 900, "at": int(NOW + 75), "v": tgboard.PAGE_V}


def test_an_old_page_version_that_wont_go_is_only_unpinned(tg):
    board_at(NOW - 3 * DAY, v=tgboard.PAGE_V - 1)
    turn()
    tgboard.look(NOW)
    assert methods(tg) == ["sendWidget", "pinChatMessage", "unpinChatMessage"]


def test_project_and_server_status_still_answer_their_lines(tg, monkeypatch):
    import bridge.devserver as devserver
    monkeypatch.setattr(devserver, "send", lambda chat, text, *a, **k: tg.texts.append((chat, text)))
    monkeypatch.setattr(dispatch.threading, "Thread",
                        lambda target, args, daemon: type("T", (), {"start": lambda self: target(*args)})())
    for text in ("/project", "/server status"):
        dispatch.on_message({"chat": {"id": CHAT, "type": "private"}, "from": {"id": CHAT},
                             "message_id": 6, "text": text})
    assert tg.texts[0][1].startswith("Active project: ")
    assert tg.texts[1][1].startswith("Server: ")
