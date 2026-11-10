"""The Live board appears when a turn starts and follows the running sessions
(bridge/tgboard.py, ticket telegram-widgets 02). Every Telegram call goes through a
recorder standing in for telegram.tg; sessions are jobs in the runner's registry."""

import json
import uuid

import pytest

from bridge import config, experimental, machine, runner, state, store, telegram, tgboard

store.init()
CHAT = config.DASH_CHAT_ID
NOW = 1794300000.0


@pytest.fixture
def tg(monkeypatch):
    """Every Bot API call, recorded; sendWidget answers a message id."""
    calls = []
    mids = iter(range(900, 10_000))

    def fake(method, **params):
        calls.append((method, params))
        return {"message_id": next(mids)} if method == "sendWidget" else True
    monkeypatch.setattr(telegram, "tg", fake)
    monkeypatch.setattr(experimental, "enabled", lambda: True)
    monkeypatch.setattr(machine, "live_session_ids", lambda: set())
    monkeypatch.setattr(state, "miniapp_url", "https://mini.example")
    store.set_setting(tgboard.KEY, None)
    tgboard._seen.clear()
    tgboard._sent.clear()
    runner._jobs.clear()
    yield calls
    runner._jobs.clear()


def turn(title="Fix login", *, started=NOW - 60, step="Bash: ls", out=None, parent=None):
    sess = store.create_session(CHAT, "proj")
    with store.closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=?, parent_session=? WHERE id=?", (title, parent, sess["id"]))
    job = runner.Job(uuid.uuid4().hex, CHAT, sess["id"])
    job.started = started
    job.events.append({"type": "tool", "name": step})
    job.tokens = {"out": out} if out else None
    runner._jobs[job.id] = job
    return sess["id"], job


def methods(calls):
    return [m for m, _ in calls]


def sent_data(calls):
    return json.loads([p for m, p in calls if m in ("sendWidget", "editMessageWidgetData")][-1]["chat_data"])


def test_a_turn_start_sends_one_silent_widget_and_pins_it(tg):
    turn("Fix login", out=12400)
    tgboard.look(NOW)
    assert methods(tg) == ["sendWidget", "pinChatMessage"]
    p = tg[0][1]
    assert p["chat_id"] == CHAT and p["disable_notification"] == "true" and p["allow_queries"] == "true"
    assert p["caption"] == "1 running"
    assert json.loads(p["reply_markup"]) == {"inline_keyboard": [[
        {"text": "◈ Open panel", "web_app": {"url": "https://mini.example"}}]]}
    assert p["html"] == open(tgboard.PAGE, encoding="utf-8").read()
    assert tg[1][1] == {"chat_id": CHAT, "message_id": 900, "disable_notification": "true"}
    rec = tgboard.record()
    assert rec["board"] == {"chat": CHAT, "msg": 900, "at": int(NOW), "v": tgboard.PAGE_V}
    assert rec["cards"] == {}             # limit cards have their place from the start
    tg.clear()
    tgboard.look(NOW + 5)
    assert tg == []


def test_the_data_follows_the_shared_shape(tg):
    sid, _ = turn("Fix login", started=NOW - 90, out=12400)
    tgboard.look(NOW)
    assert sent_data(tg) == {"v": 1, "at": int(NOW), "rows": [
        {"k": sid[:8], "c": "r", "t": "Fix login", "s": "Bash: ls", "a": int(NOW - 90), "n": "12.4k"}]}


def test_a_changed_step_sends_one_data_edit_and_nothing_else(tg):
    _, job = turn()
    tgboard.look(NOW)
    tg.clear()
    job.events.append({"type": "tool", "name": "Read", "summary": "a.py"})
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData"]
    assert sent_data(tg)["rows"][0]["s"] == "Read: a.py" and sent_data(tg)["at"] == int(NOW + 5)


def test_an_unchanged_board_waits_for_the_minute_refresh(tg):
    turn()
    tgboard.look(NOW)
    tg.clear()
    for t in range(5, 60, 5):
        tgboard.look(NOW + t)
    assert tg == []
    tgboard.look(NOW + 60)
    assert methods(tg) == ["editMessageWidgetData"]


def test_caption_and_buttons_change_together_only_when_they_change(tg, monkeypatch):
    turn("one")
    tgboard.look(NOW)
    tg.clear()
    turn("two", started=NOW)
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData", "editMessageCaption"]
    assert tg[1][1]["caption"] == "2 running"
    tg.clear()
    monkeypatch.setattr(state, "miniapp_url", "https://moved.example")   # a restart's new address
    tgboard.look(NOW + 10)
    assert methods(tg) == ["editMessageCaption"]
    assert "moved.example" in tg[0][1]["reply_markup"]


def test_the_last_turn_ending_reads_nothing_running(tg):
    _, job = turn()
    tgboard.look(NOW)
    tg.clear()
    job.status = "done"
    tgboard.look(NOW + 5)
    assert methods(tg) == ["editMessageWidgetData", "editMessageCaption"]
    assert sent_data(tg)["rows"] == [] and tg[1][1]["caption"] == "nothing running"
    tg.clear()
    tgboard.look(NOW + 125)               # nothing runs: no minute refresh
    assert tg == []


def test_no_board_without_a_turn_start(tg):
    tgboard.look(NOW)
    assert tg == []


@pytest.mark.parametrize("off", ["switch", "token", "chat"])
def test_off_makes_no_widget_call(tg, monkeypatch, off):
    if off == "switch":
        monkeypatch.setattr(experimental, "enabled", lambda: False)
    elif off == "token":
        monkeypatch.setattr(config, "TOKEN", "")
    else:
        monkeypatch.setattr(config, "DASH_CHAT_ID", 0)
    turn()
    tgboard.look(NOW)
    assert tg == []


def test_no_mini_app_address_means_no_buttons(tg, monkeypatch):
    monkeypatch.setattr(state, "miniapp_url", None)
    turn()
    tgboard.look(NOW)
    assert tg[0][1]["reply_markup"] is None


def test_rows_newest_first_helpers_folded_at_most_seven(tg):
    chat_sid, _ = turn("chat", started=NOW - 500)
    turn("helper a", started=NOW - 10, parent=chat_sid)
    turn("helper b", started=NOW - 5, parent=chat_sid)
    for i in range(8):
        turn(f"s{i}", started=NOW - 100 + i)
    tgboard.look(NOW)
    d = sent_data(tg)
    assert [r["t"] for r in d["rows"]] == ["s7", "s6", "s5", "s4", "s3", "s2", "s1"]
    assert d["more"] == 2
    assert tg[0][1]["caption"] == "9 running"


def test_a_chat_whose_own_turn_is_over_shows_one_helpers_row(tg):
    chat_sid, job = turn("chat", started=NOW - 500)
    job.status = "done"
    turn("helper a", started=NOW - 40, parent=chat_sid)
    turn("helper b", started=NOW - 20, parent=chat_sid)
    tgboard.look(NOW)
    assert sent_data(tg)["rows"] == [
        {"k": chat_sid[:8], "c": "h", "t": "chat", "s": "2 helpers working", "a": int(NOW - 40)}]
    assert tg[0][1]["caption"] == "1 running"


def test_claudes_own_agents_after_the_turn_also_make_a_helpers_row(tg, monkeypatch):
    sid, job = turn("chat", started=NOW - 300)
    job.status = "done"
    store.set_claude_session_id(sid, "csid-1")
    monkeypatch.setattr(machine, "live_session_ids", lambda: {"csid-1"})
    monkeypatch.setattr(runner, "_running_agents", lambda csid: 3)
    tgboard.look(NOW)
    assert sent_data(tg)["rows"][0] == {"k": sid[:8], "c": "h", "t": "chat", "s": "3 helpers working",
                                        "a": int(NOW - 300)}


def test_the_data_fits_with_twelve_long_multibyte_titles(tg):
    for i in range(12):
        turn("جلسهٔ بازبینی طراحی صفحهٔ اصلی " * 3 + str(i), step="🔧" * 40, out=123456, started=NOW - i)
    tgboard.look(NOW)
    raw = [p for m, p in tg if m == "sendWidget"][0]["chat_data"]
    assert len(raw.encode()) <= tgboard.DATA_MAX
    d = json.loads(raw)                   # cut on a character boundary, or this would not parse cleanly
    assert len(d["rows"]) + d["more"] == 12 and len(d["rows"]) <= 7
    for r in d["rows"]:
        assert len(r["t"].encode()) <= tgboard.TITLE_B and len(r["s"].encode()) <= tgboard.STEP_B
        assert "�" not in r["t"] + r["s"]
    assert "\\u" not in raw               # written without escaping non-ASCII


def test_the_data_holds_nothing_secret(tg):
    turn()
    tgboard.look(NOW)
    raw = [p for m, p in tg if m == "sendWidget"][0]
    for secret in (config.TOKEN, config.DASH_TOKEN, "mini.example"):
        assert secret not in raw["chat_data"] and secret not in raw["html"]


def test_the_pin_line_for_the_boards_pin_is_deleted(tg):
    turn()
    tgboard.look(NOW)
    tg.clear()
    line = {"message_id": 901, "chat": {"id": CHAT}, "pinned_message": {"message_id": 900}}
    assert tgboard.pin_line(line) is True
    assert tg == [("deleteMessage", {"chat_id": CHAT, "message_id": 901})]


def test_a_refused_delete_leaves_the_line_and_nothing_else_happens(tg, monkeypatch):
    turn()
    tgboard.look(NOW)
    monkeypatch.setattr(telegram, "tg", lambda m, **p: tg.append((m, p)) and None)
    assert tgboard.pin_line({"message_id": 901, "chat": {"id": CHAT}, "pinned_message": {"message_id": 900}})


def test_other_messages_and_other_pins_pass_through(tg):
    turn()
    tgboard.look(NOW)
    tg.clear()
    assert not tgboard.pin_line({"message_id": 5, "chat": {"id": CHAT}, "text": "hi"})
    assert not tgboard.pin_line({"message_id": 6, "chat": {"id": CHAT}, "pinned_message": {"message_id": 3}})
    assert not tgboard.pin_line({"message_id": 7, "chat": {"id": 42}, "pinned_message": {"message_id": 900}})
    assert tg == []



def test_a_helpers_row_with_no_known_start_carries_no_time_and_edits_nothing(tg, monkeypatch):
    sess = store.create_session(CHAT, "proj")
    store.set_claude_session_id(sess["id"], "csid-2")
    monkeypatch.setattr(machine, "live_session_ids", lambda: {"csid-2"})
    monkeypatch.setattr(runner, "_running_agents", lambda csid: 2)
    tgboard.look(NOW)
    assert "a" not in sent_data(tg)["rows"][0]
    tg.clear()
    tgboard.look(NOW + 5)
    assert tg == []
