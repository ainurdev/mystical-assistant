"""Stop a turn from the Live board (bridge/tgboard.py, ticket telegram-widgets 05): a
widget_query is acted on only from an allow-listed sender, in the owner's chat, on the
recorded board, with a key the board last sent; each gets exactly one answer. And the
poll asks for widget_query, falling back to its old list when Telegram refuses it."""

import json
import threading
import urllib.parse
import uuid

import pytest

from bridge import config, experimental, machine, runner, state, store, telegram, tgboard

store.init()
CHAT = config.DASH_CHAT_ID
NOW = 1794300000.0


class Calls(list):
    stopped: list


@pytest.fixture
def tg(monkeypatch):
    calls, stopped = Calls(), []
    mids = iter(range(900, 10_000))

    def fake(method, **params):
        calls.append((method, params))
        return {"message_id": next(mids)} if method == "sendWidget" else True
    monkeypatch.setattr(telegram, "tg", fake)
    monkeypatch.setattr(experimental, "enabled", lambda: True)
    monkeypatch.setattr(machine, "live_session_ids", lambda: set())
    monkeypatch.setattr(state, "miniapp_url", "https://mini.example")
    monkeypatch.setattr(runner.Job, "interrupt", lambda job: stopped.append(job.id) or job.status == "running")
    store.set_setting(tgboard.KEY, None)
    tgboard._seen.clear()
    tgboard._sent.clear()
    runner._jobs.clear()
    calls.stopped = stopped
    yield calls
    runner._jobs.clear()


def turn(title="Fix login", parent=None):
    sess = store.create_session(CHAT, "proj")
    with store.closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=?, parent_session=? WHERE id=?", (title, parent, sess["id"]))
    job = runner.Job(uuid.uuid4().hex, CHAT, sess["id"])
    job.started = NOW - 60
    runner._jobs[job.id] = job
    return sess["id"], job


def board_up(tg):
    """A turn running and its board sent: (session id, job, the board's message id)."""
    sid, job = turn()
    tgboard.look(NOW)
    tg.clear()
    return sid, job, tgboard.record()["board"]["msg"]


def ask(msg, data, *, sender=CHAT, chat=CHAT, qid="q1"):
    tgboard.query({"id": qid, "from": {"id": sender}, "chat": {"id": chat, "type": "private"},
                   "message_id": msg, "chat_instance": "x", "type": "data", "data": data})


def answers(calls):
    return [(p["widget_query_id"], p["data"]) for m, p in calls if m == "answerWidgetQuery"]


def test_a_stop_from_the_owner_on_the_board_interrupts_once_answers_ok_and_looks(tg):
    sid, job, msg = board_up(tg)
    ask(msg, f"s:{sid[:8]}")
    assert tg.stopped == [job.id]
    assert answers(tg) == [("q1", "ok")]
    assert tg[0][0] == "answerWidgetQuery"         # answered first, then the look
    job.status = "done"                               # the turn has stopped: the look drops its row
    runner._jobs.clear()
    tg.clear()
    ask(msg, f"s:{sid[:8]}", qid="q2")
    assert answers(tg) == [("q2", "gone")]


@pytest.mark.parametrize("case", ["unknown key", "old board", "stranger", "other chat", "not a stop", "helpers row"])
def test_anything_else_stops_nothing_and_is_answered_no(tg, case):
    sid, job, msg = board_up(tg)
    key = f"s:{sid[:8]}"
    if case == "unknown key":
        ask(msg, "s:deadbeef")
    elif case == "old board":
        ask(msg - 1, key)
    elif case == "stranger":
        ask(msg, key, sender=777)
    elif case == "other chat":
        ask(msg, key, chat=777, sender=777)
    elif case == "not a stop":
        ask(msg, f"x:{sid[:8]}")
    else:
        helper_parent, _ = turn("parent")
        runner._jobs.clear()
        hsid, _ = turn("helper", parent=helper_parent)
        tgboard.look(NOW + 1)                      # the parent now shows as one "helpers working" row
        tg.clear()
        ask(msg, f"s:{helper_parent[:8]}")
    assert tg.stopped == []
    assert answers(tg) == [("q1", "no")]


def test_a_turn_that_already_ended_is_answered_gone(tg):
    sid, job, msg = board_up(tg)
    job.status = "done"                               # ended after the board last showed it
    ask(msg, f"s:{sid[:8]}")
    assert answers(tg) == [("q1", "gone")]


def test_a_failing_handler_still_answers_once(tg, monkeypatch):
    sid, job, msg = board_up(tg)
    monkeypatch.setattr(runner, "_latest_jobs", lambda: 1 / 0)
    ask(msg, f"s:{sid[:8]}")
    assert answers(tg) == [("q1", "no")]


def test_queries_are_handled_off_the_poll_thread(tg, monkeypatch):
    seen = []
    done = threading.Event()
    monkeypatch.setattr(tgboard, "query", lambda q: (seen.append(threading.current_thread()), done.set()))
    tgboard.on_query({"id": "q"})
    assert done.wait(5) and seen[0] is not threading.current_thread()


def _poll(monkeypatch, replies):
    urls = []

    def fake(url, params=None, timeout=30):
        urls.append(json.loads(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["allowed_updates"][0]))
        return replies.pop(0)
    monkeypatch.setattr(telegram, "_api", fake)
    monkeypatch.setattr(telegram, "_updates", telegram.UPDATES)
    return urls


def test_the_poll_asks_for_widget_queries(monkeypatch):
    urls = _poll(monkeypatch, [{"ok": True, "result": [{"update_id": 1}]}])
    assert telegram.get_updates(0) == [{"update_id": 1}]
    assert urls == [["message", "callback_query", "stopped_message_generation", "widget_query"]]


def test_a_refused_update_list_falls_back_logs_once_and_keeps_polling(monkeypatch, capsys):
    refusal = {"ok": False, "error_code": 400, "description": "Bad Request: some text never seen"}
    urls = _poll(monkeypatch, [refusal, {"ok": True, "result": []}, refusal, {"ok": True, "result": [{"update_id": 2}]}])
    assert telegram.get_updates(0) == []
    assert telegram.get_updates(0) == []
    assert telegram.get_updates(0) == []           # a later refusal on the old list changes nothing
    assert telegram.get_updates(0) == [{"update_id": 2}]
    old = ["message", "callback_query", "stopped_message_generation"]
    assert urls == [telegram.UPDATES, old, old, old]
    assert capsys.readouterr().err.count("back to") == 1


def test_a_conflict_is_no_reason_to_fall_back(monkeypatch):
    urls = _poll(monkeypatch, [{"ok": False, "error_code": 409, "description": "Conflict"}, {"ok": True, "result": []}])
    telegram.get_updates(0)
    telegram.get_updates(0)
    assert urls == [telegram.UPDATES, telegram.UPDATES]
