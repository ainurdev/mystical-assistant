"""The limit card (bridge/tgboard.py, ticket telegram-widgets 08): both usage-limit
notices go through one sender, which sends a widget in the owner's chat when the
Live board is on and today's text otherwise; each look keeps the card true to the
session's park. Same recorder as test_tgboard_refusals: every Bot API call, with
refusals set per method."""

import json
import time
import uuid

import pytest

from bridge import (accounts, config, dispatch, experimental, ladder, limits, machine, notices,
                    runner, state, store, telegram, tgboard)

store.init()
CHAT = config.DASH_CHAT_ID
NOW = 1794300000.0


class Calls(list):
    refuse: dict


@pytest.fixture
def tg(monkeypatch):
    calls, refuse = Calls(), {}
    mids = iter(range(700, 10_000))

    def fake(method, **params):
        calls.append((method, params))
        telegram._last.error = refuse.get(method, "")
        if method in refuse:
            return None
        if method in ("sendWidget", "sendMessage"):
            return {"message_id": next(mids)}
        return True
    monkeypatch.setattr(telegram, "tg", fake)
    monkeypatch.setattr(experimental, "enabled", lambda: True)
    monkeypatch.setattr(machine, "live_session_ids", lambda: set())
    monkeypatch.setattr(state, "miniapp_url", "https://mini.example")
    monkeypatch.setattr(notices, "telegram_ok", lambda kind: True)
    monkeypatch.setattr(config, "AUTO_RESUME", True)
    monkeypatch.setattr(accounts, "pick", lambda exclude=(), strategy="best": None)   # no other login: the plain notice
    monkeypatch.setattr(limits, "_reset_epoch", lambda now, slot=None: RESET[0])
    RESET[0] = time.time() + 3600
    store.set_setting(tgboard.KEY, None)
    tgboard._seen.clear()
    tgboard._sent.clear()
    tgboard._wait[0] = 0
    runner._jobs.clear()
    calls.refuse = refuse
    yield calls
    runner._jobs.clear()
    for sid in list(limits.parked()):
        limits.cancel(sid)


RESET = [0.0]


def methods(calls):
    return [m for m, _ in calls]


def session(title="Fix login", chat=CHAT):
    sess = store.create_session(chat, "proj", cwd="/tmp/lim")
    store.set_claude_session_id(sess["id"], "c-" + sess["id"])
    with store.closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=? WHERE id=?", (title, sess["id"]))
    return store.get_session(sess["id"])


def hit_limit(sess, chat=CHAT):
    """A turn that dies on the usage limit, through the runner's own hook."""
    job = runner.Job(uuid.uuid4().hex, chat, sess["id"])
    job.status = "error"
    job.result = "You've hit your usage limit · resets 3pm"
    assert runner._maybe_auto_resume(job, "/tmp/lim", "opus", None) is True
    return job


def offer(sess, monkeypatch, chat=CHAT):
    """A park where another login is free and the policy is to ask: the choice."""
    monkeypatch.setattr(accounts, "pick", lambda exclude=(), strategy="best": 2)
    monkeypatch.setattr(accounts, "headroom", lambda slot: 55)
    store.set_fallback_policy(sess["id"], "ask")
    hit_limit(sess, chat)


# --- the sender ----------------------------------------------------------------

def test_switch_off_the_plain_notice_is_todays_text(tg, monkeypatch):
    monkeypatch.setattr(experimental, "enabled", lambda: False)
    hit_limit(session())
    assert methods(tg) == ["sendMessage"]
    p = tg[0][1]
    assert "usage limit hit" in p["text"] and "will auto-resume" in p["text"]
    assert p["disable_notification"] == "true"
    assert "Open Panel" in p["reply_markup"]


def test_switch_off_the_choice_is_todays_text_with_switch_and_wait(tg, monkeypatch):
    monkeypatch.setattr(experimental, "enabled", lambda: False)
    offer(session(), monkeypatch)
    assert methods(tg) == ["sendMessage"]
    p = tg[0][1]
    assert p["text"].startswith("⛔ Usage limit reached.")
    assert not p.get("disable_notification")             # the choice rings
    assert "fb:a:" in p["reply_markup"] and "fb:w:" in p["reply_markup"]


def test_switch_on_the_plain_notice_is_a_card_with_todays_caption_and_silence(tg):
    sess = session()
    hit_limit(sess)
    assert methods(tg) == ["sendWidget"]
    p = tg[0][1]
    assert "usage limit hit" in p["caption"] and "will auto-resume" in p["caption"]
    assert p["disable_notification"] == "true"
    assert "Open Panel" in p["reply_markup"]
    d = json.loads(p["chat_data"])
    assert d["t"] == "Fix login" and d["s"] == "w"
    assert d["a"] == int(limits.parked()[sess["id"]]["at"])
    assert "<script>" in p["html"]


def test_switch_on_the_choice_is_a_card_that_rings_with_switch_and_wait(tg, monkeypatch):
    offer(session(), monkeypatch)
    assert methods(tg) == ["sendWidget"]
    p = tg[0][1]
    assert p["caption"].startswith("⛔ Usage limit reached.")
    assert not p.get("disable_notification")
    assert "fb:a:" in p["reply_markup"] and "fb:w:" in p["reply_markup"]
    assert json.loads(p["chat_data"])["s"] == "c"


def test_a_group_gets_todays_text(tg):
    hit_limit(session(chat=-100123), chat=-100123)
    assert methods(tg) == ["sendMessage"]


def test_a_refused_card_falls_back_to_todays_text(tg):
    tg.refuse["sendWidget"] = "Bad Request: widgets are not allowed"
    hit_limit(session())
    assert methods(tg) == ["sendWidget", "sendMessage"]
    assert "will auto-resume" in tg[1][1]["text"]
    assert tgboard.record()["cards"] == {}


def test_the_card_is_recorded_beside_the_board(tg):
    sess = session()
    hit_limit(sess)
    card = tgboard.record()["cards"][sess["id"]]
    assert (card["chat"], card["msg"], card["s"]) == (CHAT, 700, "w")


# --- the buttons ---------------------------------------------------------------

def tap(data, msg_id, widget=True):
    msg = {"message_id": msg_id, "chat": {"id": CHAT}, **({"widget": {}} if widget else {})}
    dispatch._fallback_callback({"id": "cb1", "message": msg}, CHAT, msg_id, data)


def test_wait_on_a_card_writes_todays_line_to_the_caption(tg, monkeypatch):
    sess = session()
    offer(sess, monkeypatch)
    tg.clear()
    tap(f"fb:w:{sess['id']}", 700)
    edits = [p for m, p in tg if m == "editMessageCaption"]
    assert [p["caption"] for p in edits] == ["⏳ Waiting for the usage limit to reset."]
    assert "editMessageText" not in methods(tg)
    assert limits.parked()[sess["id"]]["offer"] is None


def test_wait_on_todays_text_still_rewrites_the_text(tg, monkeypatch):
    monkeypatch.setattr(experimental, "enabled", lambda: False)
    sess = session()
    offer(sess, monkeypatch)
    tg.clear()
    tap(f"fb:w:{sess['id']}", 700, widget=False)
    assert [p["text"] for m, p in tg if m == "editMessageText"] == ["⏳ Waiting for the usage limit to reset."]


def test_switch_on_a_card_writes_todays_line_to_the_caption(tg, monkeypatch):
    sess = session()
    offer(sess, monkeypatch)
    monkeypatch.setattr(ladder, "take", lambda s, chat, rung: rung)
    tg.clear()
    tap(f"fb:a:{sess['id']}:2", 700)
    assert [p["caption"] for m, p in tg if m == "editMessageCaption"] == ["↪ Continuing on account 2."]


# --- the look ------------------------------------------------------------------

def card_edits(calls):
    return [json.loads(p["chat_data"]) for m, p in calls if m == "editMessageWidgetData" and p["message_id"] == 700]


def test_a_look_with_nothing_changed_edits_nothing(tg):
    hit_limit(session())
    tg.clear()
    tgboard.look(NOW)
    tgboard.look(NOW + 5)
    assert card_edits(tg) == [] and "editMessageCaption" not in methods(tg)


def test_a_choice_answered_elsewhere_becomes_waiting_without_switch_or_wait(tg, monkeypatch):
    sess = session()
    offer(sess, monkeypatch)
    tg.clear()
    limits.offer(sess["id"], None)               # chose Wait on the dashboard
    tgboard.look(NOW)
    assert [d["s"] for d in card_edits(tg)] == ["w"]
    cap = [p for m, p in tg if m == "editMessageCaption"]
    assert cap[0]["caption"] == "⏳ Waiting for the usage limit to reset."
    assert "fb:" not in cap[0]["reply_markup"]
    tg.clear()
    tgboard.look(NOW + 5)
    assert tg == []


def test_a_wait_tapped_on_the_card_is_not_written_twice(tg, monkeypatch):
    sess = session()
    offer(sess, monkeypatch)
    tap(f"fb:w:{sess['id']}", 700)
    tg.clear()
    tgboard.look(NOW)
    assert [d["s"] for d in card_edits(tg)] == ["w"]
    assert "editMessageCaption" not in methods(tg)


def test_a_moved_resume_time_moves_the_countdown(tg):
    sess = session()
    hit_limit(sess)
    later = RESET[0] + 1800
    with limits._lock:
        limits._pending[sess["id"]]["at"] = later
    tg.clear()
    tgboard.look(NOW)
    assert [(d["s"], d["a"]) for d in card_edits(tg)] == [("w", int(later))]


def test_running_again_says_resumed_then_the_card_is_dropped(tg):
    sess = session()
    hit_limit(sess)
    limits.cancel(sess["id"])
    job = runner.Job(uuid.uuid4().hex, CHAT, sess["id"])
    job.started = NOW - 1
    runner._jobs[job.id] = job
    tg.clear()
    tgboard.look(NOW)
    d = card_edits(tg)
    assert [x["s"] for x in d] == ["r"] and d[0]["e"] == int(NOW)
    assert tgboard.record()["cards"] == {}


def test_no_longer_parked_and_not_running_says_so_then_the_card_is_dropped(tg):
    sess = session()
    hit_limit(sess)
    limits.cancel(sess["id"])
    tg.clear()
    tgboard.look(NOW)
    assert [d["s"] for d in card_edits(tg)] == ["g"]
    assert tgboard.record()["cards"] == {}


def test_a_resumed_choice_loses_its_buttons(tg, monkeypatch):
    sess = session()
    offer(sess, monkeypatch)
    limits.cancel(sess["id"])
    tg.clear()
    tgboard.look(NOW)
    cap = [p for m, p in tg if m == "editMessageCaption"]
    assert len(cap) == 1 and "fb:" not in cap[0]["reply_markup"]


def test_a_restart_keeps_the_link(tg):
    sess = session()
    hit_limit(sess)
    tgboard._seen.clear()
    tgboard._sent.clear()                        # what a restart loses
    tg.clear()
    tgboard.look(NOW)
    assert card_edits(tg) == []
    limits.cancel(sess["id"])
    tgboard.look(NOW + 5)
    assert [d["s"] for d in card_edits(tg)] == ["g"]


def test_a_deleted_card_is_forgotten(tg):
    sess = session()
    hit_limit(sess)
    limits.cancel(sess["id"])
    tg.refuse["editMessageWidgetData"] = "Bad Request: message with widget to edit not found"
    tgboard.look(NOW)
    assert tgboard.record()["cards"] == {}


def test_a_refused_card_edit_is_tried_again(tg):
    sess = session()
    hit_limit(sess)
    limits.cancel(sess["id"])
    tg.refuse["editMessageWidgetData"] = "Internal Server Error"
    tgboard.look(NOW)
    assert sess["id"] in tgboard.record()["cards"]
    del tg.refuse["editMessageWidgetData"]
    tg.clear()
    tgboard.look(NOW + 5)
    assert [d["s"] for d in card_edits(tg)] == ["g"]


def test_the_resuming_text_is_sent_as_today(tg):
    sess = session()
    hit_limit(sess)
    tg.clear()
    sent = []
    with limits._lock:
        limits._pending[sess["id"]]["at"] = time.time() - 1
    limits._fire(run=lambda *a, **k: object(), notify=lambda chat, text, silent=False: sent.append((text, silent)))
    assert sent == [("🔄 Usage limit reset — resuming your session.", True)]
