"""HTTP surface for the fallback ladder: account meters + per-session policy,
on both the dashboard (/local/...) and the Mini App (/api/...). Driven without
sockets via Handler.__new__ (mirrors test_graph_endpoints.py).
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("ACCOUNTS_DIR", os.path.join(tempfile.mkdtemp(), "accounts"))

from bridge import accounts, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402

store.init()
CHAT = 555


def _dash_handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _mini_handler():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _stub_accounts(rows, left=50):
    saved = (accounts.list_accounts, accounts.headroom)
    accounts.list_accounts = lambda: rows
    accounts.headroom = lambda slot: left
    return lambda: (setattr(accounts, "list_accounts", saved[0]),
                    setattr(accounts, "headroom", saved[1]))


ROWS = [{"slot": 1, "email": "a@x.com", "alias": None, "disabled": False,
         "default": True},
        {"slot": 2, "email": "b@x.com", "alias": None, "disabled": False,
         "default": False}]


# --- accounts list -----------------------------------------------------------

def test_dashboard_accounts_endpoint_lists_slots_with_headroom():
    restore = _stub_accounts(ROWS, left=78)
    h, box = _dash_handler()
    try:
        h._get_api("/local/accounts", {})
        assert box["code"] == 200
        got = box["obj"]["accounts"]
        assert [a["slot"] for a in got] == [1, 2]
        assert got[0]["left"] == 78 and got[1]["email"] == "b@x.com"
    finally:
        restore()


def test_accounts_payload_carries_the_current_default_policy():
    """The settings tab renders both from one call."""
    from bridge import ladder
    restore = _stub_accounts(ROWS)
    h, box = _dash_handler()
    try:
        ladder.set_default_policy("auto")
        h._get_api("/local/accounts", {})
        assert box["obj"]["default_policy"] == "auto"
    finally:
        ladder.set_default_policy(None)
        restore()


def test_miniapp_accounts_endpoint_matches():
    restore = _stub_accounts(ROWS, left=12)
    h, box = _mini_handler()
    try:
        h._api_accounts(CHAT)
        assert box["code"] == 200
        assert [a["left"] for a in box["obj"]["accounts"]] == [12, 12]
    finally:
        restore()


# --- per-session policy ------------------------------------------------------

def test_dashboard_sets_a_sessions_policy():
    s = store.create_session(CHAT, "/pol1")
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{s['id']}/policy", {"policy": "auto"})
    assert box["code"] == 200 and box["obj"]["ok"] is True
    assert store.get_session(s["id"])["fallback_policy"] == "auto"


def test_dashboard_rejects_an_unknown_policy():
    s = store.create_session(CHAT, "/pol2")
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{s['id']}/policy", {"policy": "yolo"})
    assert box["code"] == 400
    assert store.get_session(s["id"])["fallback_policy"] is None


def test_dashboard_404s_a_foreign_session():
    s = store.create_session(999, "/pol3")
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{s['id']}/policy", {"policy": "auto"})
    assert box["code"] == 404
    assert store.get_session(s["id"])["fallback_policy"] is None


def test_miniapp_sets_and_clears_a_sessions_policy():
    """Empty policy = back to the configured default (NULL in the DB)."""
    s = store.create_session(CHAT, "/pol4")
    h, box = _mini_handler()
    h._api_session_policy(CHAT, s["id"], {"policy": "wait"})
    assert box["code"] == 200
    assert store.get_session(s["id"])["fallback_policy"] == "wait"

    h._api_session_policy(CHAT, s["id"], {"policy": None})
    assert box["code"] == 200
    assert store.get_session(s["id"])["fallback_policy"] is None


# --- global default policy (settings tab) ------------------------------------

def test_default_policy_falls_back_to_the_env_setting():
    from bridge import config, ladder
    ladder.set_default_policy(None)          # nothing persisted
    assert ladder.default_policy() == config.FALLBACK_POLICY


def test_default_policy_persists_across_a_reload():
    from bridge import ladder
    try:
        ladder.set_default_policy("auto")
        assert ladder.default_policy() == "auto"
        ladder._cache = None                 # simulate a bridge restart
        assert ladder.default_policy() == "auto"
    finally:
        ladder.set_default_policy(None)


def test_a_session_without_its_own_policy_uses_the_stored_default():
    from bridge import ladder
    s = store.create_session(CHAT, "/pol6")
    try:
        ladder.set_default_policy("wait")
        assert ladder.policy_for(store.get_session(s["id"])) == "wait"
    finally:
        ladder.set_default_policy(None)


def test_a_sessions_own_policy_still_beats_the_stored_default():
    from bridge import ladder
    s = store.create_session(CHAT, "/pol7")
    store.set_fallback_policy(s["id"], "ask")
    try:
        ladder.set_default_policy("auto")
        assert ladder.policy_for(store.get_session(s["id"])) == "ask"
    finally:
        ladder.set_default_policy(None)


def test_dashboard_sets_the_default_policy():
    from bridge import ladder
    h, box = _dash_handler()
    try:
        h._post_api("/local/policy/default", {"policy": "auto"})
        assert box["code"] == 200
        assert ladder.default_policy() == "auto"
    finally:
        ladder.set_default_policy(None)


def test_dashboard_rejects_an_unknown_default_policy():
    h, box = _dash_handler()
    h._post_api("/local/policy/default", {"policy": "yolo"})
    assert box["code"] == 400


# --- account actions (settings tab) ------------------------------------------

def _stub_action(name, ret=None):
    saved = getattr(accounts, name)
    calls = []

    def fn(*a, **kw):
        calls.append((a, kw))
        return ret

    setattr(accounts, name, fn)
    return calls, (lambda: setattr(accounts, name, saved))


def test_dashboard_adds_an_account():
    calls, restore = _stub_action("add", ret=2)
    h, box = _dash_handler()
    try:
        h._post_api("/local/accounts", {"action": "add"})
        assert box["code"] == 200 and box["obj"]["slot"] == 2
        assert len(calls) == 1
    finally:
        restore()


def test_dashboard_reports_a_missing_login_as_a_clean_error():
    saved = accounts.add

    def boom(*a, **kw):
        raise accounts.NoLogin("no login")

    accounts.add = boom
    h, box = _dash_handler()
    try:
        h._post_api("/local/accounts", {"action": "add"})
        assert box["code"] == 400
        assert "login" in box["obj"]["error"].lower()
    finally:
        accounts.add = saved


def test_dashboard_disables_and_removes_by_slot():
    for action in ("disable", "enable", "remove"):
        calls, restore = _stub_action(action)
        h, box = _dash_handler()
        try:
            h._post_api("/local/accounts", {"action": action, "slot": 2})
            assert box["code"] == 200, f"{action} failed"
            assert calls[0][0] == (2,)
        finally:
            restore()


def test_dashboard_rejects_an_unknown_account_action():
    h, box = _dash_handler()
    h._post_api("/local/accounts", {"action": "nuke", "slot": 2})
    assert box["code"] == 400


def test_removing_the_ambient_login_is_refused_not_crashed():
    h, box = _dash_handler()
    h._post_api("/local/accounts", {"action": "remove", "slot": 1})
    assert box["code"] == 400


def test_session_brief_carries_the_policy():
    """The UIs need the current value to render the picker state."""
    s = store.create_session(CHAT, "/pol5")
    store.set_fallback_policy(s["id"], "auto")
    brief = mini._session_brief(store.get_session(s["id"]))
    assert brief["fallback_policy"] == "auto"


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
