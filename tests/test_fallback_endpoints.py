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
