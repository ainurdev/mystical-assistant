"""/local/notices and the `needs` + `seen` riders on /local/running, driven
without sockets via the Handler.__new__ trick (test_running_watched.py).
Run: python3 -m pytest tests/test_notices_endpoint.py -q"""

import time
from contextlib import closing

import pytest

from bridge import notices, store
from bridge.dashboard import server as dash


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    store.init()
    with closing(store._connect()) as c:
        c.execute("DELETE FROM notices")
    store.set_setting("notify_prefs", None)
    monkeypatch.setattr(notices, "_last_seen", float("-inf"))
    monkeypatch.setattr(dash.runner, "running_snapshot", lambda chat: {
        "status": {"s1": {"state": "awaiting", "kind": "question", "label": "Which one?"}},
        "jobs": []})


def _call(method, path, arg):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    (h._get_api if method == "GET" else h._post_api)(path, arg)
    return box["code"], box["obj"]


def test_get_notices_shape():
    nid = notices.emit("pr_failing", "pr:o/r:x", title="#9 · x", body="lint")
    code, obj = _call("GET", "/local/notices", {})
    assert code == 200
    assert [n["id"] for n in obj["notices"]] == [nid]
    assert obj["notices"][0]["verb"] == "CHECKS FAILING"
    assert obj["prefs"]["events"]["pr"]["sound"] == "blip"
    assert obj["quiet"] is False
    assert obj["telegram"] is True          # NOTIFY_ENABLE on and a bot token set (conftest)


def test_get_notices_says_when_telegram_is_off(monkeypatch):
    from bridge import config
    monkeypatch.setattr(config, "NOTIFY_ENABLE", False)
    assert _call("GET", "/local/notices", {})[1]["telegram"] is False


def test_post_read_all_and_ids():
    a = notices.emit("done", "s1", title="a")
    b = notices.emit("done", "s2", title="b")
    assert _call("POST", "/local/notices", {"op": "read", "ids": [a, "x"]}) == (200, {"ok": True, "n": 1})
    assert _call("POST", "/local/notices", {"op": "read", "all": True}) == (200, {"ok": True, "n": 1})
    assert all(n["read"] for n in notices.feed()) and b


def test_post_prefs_roundtrip():
    code, obj = _call("POST", "/local/notices", {"op": "prefs", "patch": {"events": {"done": {"tg": "off"}}}})
    assert code == 200 and obj["prefs"]["events"]["done"]["tg"] == "off"
    assert _call("GET", "/local/notices", {})[1]["prefs"]["events"]["done"]["tg"] == "off"


def test_post_bad_op_400():
    assert _call("POST", "/local/notices", {"op": "explode"})[0] == 400
    assert _call("POST", "/local/notices", {"op": "read"})[0] == 400


def test_running_carries_needs_and_seen():
    t = time.time() - 30
    code, obj = _call("GET", "/local/running", {"seen": [str(t)]})
    assert code == 200
    assert notices._last_seen == pytest.approx(t)
    assert [(n["subject"], n["kind"], n["body"]) for n in obj["needs"]] == [("s1", "question", "Which one?")]
    # A seen that isn't a number is ignored, not a 500.
    assert _call("GET", "/local/running", {"seen": ["soon"]})[0] == 200


def test_post_limit_wait_and_switch(monkeypatch):
    from bridge import ladder
    sid = store.create_session(555, "/repo", origin="dashboard")["id"]
    assert _call("POST", "/local/notices", {"op": "limit", "session": sid}) == (200, {"ok": True})
    assert notices.feed()[0]["kind"] == "waiting"
    took = []
    monkeypatch.setattr(ladder, "take", lambda sess, chat, rung, **k: took.append((sess["id"], rung["slot"])) or rung)
    assert _call("POST", "/local/notices", {"op": "limit", "session": sid, "slot": 2}) == (200, {"ok": True})
    assert took == [(sid, 2)]
    assert _call("POST", "/local/notices", {"op": "limit", "session": "nope"})[0] == 404


def test_get_changelog_is_updates_and_notes_only():
    notices.emit("pr_failing", "pr:o/r:x", title="#9 · x", body="lint")
    nid = notices.emit("updated", "update:abc", title="Changelog moves", body="a\nb")
    assert _call("GET", "/local/changelog", {}) == (200, {"notices": notices.changelog()})
    assert [n["id"] for n in notices.changelog()] == [nid]


# --- POST /local/update/note -------------------------------------------------------

def test_update_note_validates(monkeypatch):
    from bridge import whatsnew
    monkeypatch.setattr(whatsnew, "add_note", lambda t, b: (_ for _ in ()).throw(AssertionError("not reached")))
    for bad in ({}, {"title": "  "}, {"title": "x" * 81}, {"title": "a\nb"},
                {"title": "ok", "body": "y" * 601}, {"title": 5}):
        assert _call("POST", "/local/update/note", bad)[0] == 400, bad


def test_update_note_calls_add_note(monkeypatch):
    from bridge import whatsnew
    got = []
    monkeypatch.setattr(whatsnew, "add_note", lambda t, b: got.append((t, b)) or (True, "pushed"))
    code, obj = _call("POST", "/local/update/note", {"title": " Hello ", "body": "a\r\nb "})
    assert code == 200 and obj == {"ok": True, "output": "pushed"} and got == [("Hello", "a\nb")]
