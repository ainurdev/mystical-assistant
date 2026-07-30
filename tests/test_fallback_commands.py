"""Telegram surface for the fallback ladder: the approval card's buttons and the
/accounts and /policy commands (bridge/dispatch.py).

The card is the default policy's whole interface — if its callbacks don't route,
'ask' is a dead end that silently degrades to waiting.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["ACCOUNTS_DIR"] = os.path.join(tempfile.mkdtemp(), "accounts")

from bridge import config, dispatch, store  # noqa: E402

store.init()
CHAT = 555


def _cb(data, chat_id=CHAT):
    return {"id": "cb1", "data": data,
            "message": {"chat": {"id": chat_id}, "message_id": 7}}


def _patch(**attrs):
    """Swap dispatch attributes; returns the restore closure."""
    saved = {k: getattr(dispatch, k) for k in attrs}
    for k, v in attrs.items():
        setattr(dispatch, k, v)
    return lambda: [setattr(dispatch, k, v) for k, v in saved.items()]


class _Rec:
    def __init__(self, ret=None):
        self.calls = []
        self._ret = ret

    def __call__(self, *a, **kw):
        self.calls.append((a, kw))
        return self._ret


PROJ = os.path.join(config.BASE_PATH, "proj")
os.makedirs(PROJ, exist_ok=True)


def _session():
    """A session keyed the way the runner keys them: project = rel(cwd)."""
    from bridge.browser import rel
    return store.create_session(CHAT, rel(PROJ), cwd=PROJ)


# --- the approval card's buttons ---------------------------------------------

def test_switch_button_takes_the_account_rung():
    s = _session()
    take = _Rec(ret={"kind": "account", "slot": 2, "label": "Account 2"})
    restore = _patch(answer_cb=_Rec(), edit=_Rec(), send=_Rec())
    saved_take = dispatch.ladder.take
    dispatch.ladder.take = take
    try:
        dispatch.handle_callback(_cb(f"fb:a:{s['id']}:2"))
        assert len(take.calls) == 1
        rung = take.calls[0][0][2]
        assert rung["kind"] == "account" and rung["slot"] == 2
    finally:
        dispatch.ladder.take = saved_take
        restore()


def test_free_agent_button_takes_the_free_rung():
    s = _session()
    take = _Rec(ret={"kind": "free", "provider": "gemini", "label": "Gemini"})
    restore = _patch(answer_cb=_Rec(), edit=_Rec(), send=_Rec())
    saved_take = dispatch.ladder.take
    dispatch.ladder.take = take
    try:
        dispatch.handle_callback(_cb(f"fb:f:{s['id']}:gemini"))
        assert len(take.calls) == 1
        assert take.calls[0][0][2]["provider"] == "gemini"
    finally:
        dispatch.ladder.take = saved_take
        restore()


def test_wait_button_takes_no_rung_and_leaves_the_session_parked():
    s = _session()
    take = _Rec()
    edit = _Rec()
    restore = _patch(answer_cb=_Rec(), edit=edit, send=_Rec())
    saved_take = dispatch.ladder.take
    dispatch.ladder.take = take
    try:
        dispatch.handle_callback(_cb(f"fb:w:{s['id']}"))
        assert take.calls == []
        assert len(edit.calls) == 1, "the card should resolve to a final state"
    finally:
        dispatch.ladder.take = saved_take
        restore()


def test_another_chat_cannot_spend_your_accounts():
    """Card callbacks are owner-scoped like the review cards."""
    s = _session()
    take = _Rec()
    restore = _patch(answer_cb=_Rec(), edit=_Rec(), send=_Rec())
    saved_take, saved_allowed = dispatch.ladder.take, config.ALLOWED_CHAT_IDS
    dispatch.ladder.take = take
    config.ALLOWED_CHAT_IDS = {CHAT, 999}
    try:
        dispatch.handle_callback(_cb(f"fb:a:{s['id']}:2", chat_id=999))
        assert take.calls == [], "session belongs to another chat"
    finally:
        dispatch.ladder.take, config.ALLOWED_CHAT_IDS = saved_take, saved_allowed
        restore()


def test_a_malformed_callback_is_answered_not_crashed():
    restore = _patch(answer_cb=_Rec(), edit=_Rec(), send=_Rec())
    try:
        dispatch.handle_callback(_cb("fb:a:"))
        dispatch.handle_callback(_cb("fb:"))
        dispatch.handle_callback(_cb("fb:a:nosuch:2"))
    finally:
        restore()


# --- /policy ----------------------------------------------------------------

def test_policy_command_shows_the_current_setting():
    send = _Rec()
    restore = _patch(send=send)
    try:
        assert dispatch.handle_fallback_command(CHAT, "/policy") is True
        assert len(send.calls) == 1
        assert "ask" in send.calls[0][0][1].lower()
    finally:
        restore()


def test_policy_command_sets_the_active_sessions_policy():
    s = _session()
    send = _Rec()
    restore = _patch(send=send)
    saved = dispatch.state.active.get(CHAT)
    dispatch.state.active[CHAT] = PROJ
    try:
        assert dispatch.handle_fallback_command(CHAT, "/policy auto") is True
        assert store.get_session(s["id"])["fallback_policy"] == "auto"
    finally:
        if saved is None:
            dispatch.state.active.pop(CHAT, None)
        else:
            dispatch.state.active[CHAT] = saved
        restore()


def test_policy_command_rejects_an_unknown_value():
    s = _session()
    send = _Rec()
    restore = _patch(send=send)
    try:
        dispatch.handle_fallback_command(CHAT, "/policy yolo")
        assert store.get_session(s["id"])["fallback_policy"] is None
        assert "yolo" in send.calls[0][0][1] or "ask" in send.calls[0][0][1]
    finally:
        restore()


# --- /accounts --------------------------------------------------------------

def test_accounts_command_lists_the_slots():
    send = _Rec()
    restore = _patch(send=send)
    try:
        assert dispatch.handle_fallback_command(CHAT, "/accounts") is True
        assert len(send.calls) == 1
    finally:
        restore()


def test_accounts_add_reports_the_new_slot():
    send = _Rec()
    restore = _patch(send=send)
    saved_add = dispatch.accounts.add
    dispatch.accounts.add = lambda *a, **kw: 2
    try:
        dispatch.handle_fallback_command(CHAT, "/accounts add")
        assert "2" in send.calls[0][0][1]
    finally:
        dispatch.accounts.add = saved_add
        restore()


def test_accounts_add_explains_a_missing_login_instead_of_erroring():
    from bridge import accounts as acc
    send = _Rec()
    restore = _patch(send=send)
    saved_add = dispatch.accounts.add

    def boom(*a, **kw):
        raise acc.NoLogin("no login")

    dispatch.accounts.add = boom
    try:
        dispatch.handle_fallback_command(CHAT, "/accounts add")
        assert "login" in send.calls[0][0][1].lower()
    finally:
        dispatch.accounts.add = saved_add
        restore()


def test_an_unrelated_command_is_not_claimed():
    assert dispatch.handle_fallback_command(CHAT, "/status") is False


if __name__ == "__main__":
    import traceback
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception:  # noqa: BLE001
                fails += 1
                print(f"FAIL {name}")
                traceback.print_exc()
    print(f"\n{fails} failure(s)")
    sys.exit(1 if fails else 0)
