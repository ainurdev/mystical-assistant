"""Shared session links: an unguessable token, one session, and a clock.

The security properties are the point of these tests. A share must not become a
way to read another session, to outlive its expiry, or to reach anything but a
rendered page.
Run: `python -m pytest tests/test_share.py`
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import share, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()
CHAT = 555


def _session(title="A session"):
    s = store.create_session(CHAT, "/shared")
    store.rename(s["id"], title)
    tid = "t-" + s["id"][:8]
    store.start_turn(s["id"], tid, "make it work", [])
    store.append_event(s["id"], tid, {"type": "text", "text": "Looking at the parser."})
    return s["id"], tid


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)      # noqa: SLF001
    h._send = lambda data, code=200, ctype="", cache="": box.update(    # noqa: SLF001
        data=data, code=code, ctype=ctype)
    return h, box


# --- the token ---------------------------------------------------------------

def test_share_renders_the_session():
    sid, _ = _session("Parser work")
    tok = store.create_share(sid)["token"]
    page = share.render(tok)
    assert page and "Parser work" in page
    assert "make it work" in page
    assert "Looking at the parser." in page


def test_tokens_are_long_and_unique():
    sid, _ = _session()
    a, b = store.create_share(sid)["token"], store.create_share(sid)["token"]
    assert a != b
    assert len(a) >= 24


def test_unknown_token_renders_nothing():
    assert share.render("not-a-real-token") is None
    assert share.render("") is None


def test_a_share_reads_only_its_own_session():
    a, _ = _session("Session A")
    b, _ = _session("Session B")
    page = share.render(store.create_share(a)["token"])
    assert "Session A" in page
    assert "Session B" not in page


# --- the clock ---------------------------------------------------------------

def test_expired_share_is_gone():
    sid, _ = _session()
    row = store.create_share(sid)
    with store.closing(store._connect()) as c:                          # noqa: SLF001
        c.execute("UPDATE shares SET expires=? WHERE token=?",
                  (time.time() - 1, row["token"]))
    assert store.get_share(row["token"]) is None
    assert share.render(row["token"]) is None


def test_days_are_clamped_to_a_week():
    sid, _ = _session()
    row = store.create_share(sid, days=365)
    assert row["expires"] - row["created"] <= store.SHARE_MAX_DAYS * 86400 + 1


def test_zero_or_negative_days_still_gives_a_live_link():
    sid, _ = _session()
    row = store.create_share(sid, days=0)
    assert row["expires"] > time.time()


def test_revoke_kills_every_link_for_a_session():
    sid, _ = _session()
    t1 = store.create_share(sid)["token"]
    t2 = store.create_share(sid)["token"]
    assert store.revoke_shares(sid) == 2
    assert store.get_share(t1) is None and store.get_share(t2) is None


def test_revoke_leaves_other_sessions_alone():
    a, _ = _session()
    b, _ = _session()
    tok = store.create_share(b)["token"]
    store.revoke_shares(a)
    assert store.get_share(tok) is not None


def test_prune_drops_only_expired_rows():
    sid, _ = _session()
    live = store.create_share(sid)["token"]
    dead = store.create_share(sid)["token"]
    with store.closing(store._connect()) as c:                          # noqa: SLF001
        c.execute("UPDATE shares SET expires=? WHERE token=?", (time.time() - 1, dead))
    store.prune_shares()
    assert store.get_share(live) is not None


# --- what the page does and doesn't carry ------------------------------------

def test_page_is_scriptless():
    sid, _ = _session()
    page = share.render(store.create_share(sid)["token"])
    assert "<script" not in page.lower()


def test_prompt_html_is_escaped():
    s = store.create_session(CHAT, "/shared")
    tid = "t-esc"
    store.start_turn(s["id"], tid, "<img src=x onerror=alert(1)>", [])
    page = share.render(store.create_share(s["id"])["token"])
    assert "<img src=x" not in page
    assert "&lt;img" in page


def test_images_are_named_but_not_served():
    s = store.create_session(CHAT, "/shared")
    tid = "t-img"
    store.start_turn(s["id"], tid, "screenshot it", [])
    store.append_event(s["id"], tid, {
        "type": "tool_done", "id": "x", "images": ["/uploads/job/a.png"]})
    page = share.render(store.create_share(s["id"])["token"])
    assert "not included in a shared session" in page
    assert "/uploads/job/a.png" not in page


# --- the endpoint ------------------------------------------------------------

def test_endpoint_mints_a_link():
    sid, _ = _session()
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/share", {"days": 3})             # noqa: SLF001
    assert box["code"] == 200
    assert box["obj"]["url"].startswith("/share/")
    assert store.get_share(box["obj"]["token"]) is not None


def test_endpoint_revokes():
    sid, _ = _session()
    tok = store.create_share(sid)["token"]
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/share", {"revoke": True})        # noqa: SLF001
    assert box["obj"]["revoked"] == 1
    assert store.get_share(tok) is None


def test_endpoint_refuses_another_chats_session():
    sid = store.create_session(999, "/notyours")["id"]
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/share", {})                      # noqa: SLF001
    assert box["code"] == 404
    assert store.list_shares(sid) == []


def test_route_404s_an_unknown_token_without_leaking_why():
    h, box = _handler()
    h._share("nope")                                                     # noqa: SLF001
    assert box["code"] == 404
    assert b"Not found or expired" in box["data"]


def test_route_serves_html_for_a_live_token():
    sid, _ = _session("Live one")
    tok = store.create_share(sid)["token"]
    h, box = _handler()
    h._share(tok)                                                        # noqa: SLF001
    assert box["code"] == 200
    assert "text/html" in box["ctype"]
    assert b"Live one" in box["data"]
