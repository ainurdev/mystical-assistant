"""HTTP surface for the AI switches and the next-up board (/local/aifeatures,
/local/next). Driven without sockets via Handler.__new__, like
tests/test_fallback_endpoints.py.
Run: python -m pytest tests/test_next_endpoints.py -v"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, config, nextup, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box: dict = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BRIDGE_DB", str(tmp_path / "bridge.db"))
    monkeypatch.setattr(aifeatures, "_cache", None)
    monkeypatch.setattr(nextup, "_path", lambda: str(tmp_path / "nextup.json"))
    yield
    monkeypatch.setattr(aifeatures, "_cache", None)


# --- AI switches -------------------------------------------------------------

def test_get_lists_every_feature_with_its_state():
    h, box = _handler()
    h._get_api("/local/aifeatures", {})
    keys = [f["key"] for f in box["obj"]["features"]]
    assert keys == [f["key"] for f in aifeatures.FEATURES]
    assert all("cost" in f and "hint" in f for f in box["obj"]["features"])


def test_post_flips_a_switch_and_answers_with_the_new_state():
    h, box = _handler()
    h._post_api("/local/aifeatures", {"key": "nextup", "enabled": True})
    assert box["obj"]["ok"] is True
    assert aifeatures.enabled("nextup") is True
    on = [f for f in box["obj"]["features"] if f["key"] == "nextup"][0]
    assert on["enabled"] is True


def test_post_rejects_an_unknown_feature():
    h, box = _handler()
    h._post_api("/local/aifeatures", {"key": "teleportation", "enabled": True})
    assert box["code"] == 400 and "error" in box["obj"]


# --- board -------------------------------------------------------------------

def test_get_serves_the_cache_and_spawns_nothing(monkeypatch):
    monkeypatch.setattr(nextup, "refresh", lambda chat: pytest.fail("GET refreshed"))
    h, box = _handler()
    h._get_api("/local/next", {})
    assert box["obj"]["items"] == [] and box["obj"]["enabled"] is False


def test_post_kicks_off_a_refresh_without_blocking(monkeypatch):
    started: list = []
    monkeypatch.setattr(nextup, "refresh",
                        lambda chat, project=None, kind="next": started.append(chat))
    h, box = _handler()
    h._post_api("/local/next", {})
    for _ in range(50):                      # the refresh runs on its own thread
        if started:
            break
        __import__("time").sleep(0.02)
    assert box["obj"]["ok"] is True and started


# --- scoped board ------------------------------------------------------------

def test_get_passes_project_and_kind_through(monkeypatch):
    seen = {}
    monkeypatch.setattr(nextup, "board",
                        lambda chat, project=None, kind="next":
                        seen.update(project=project, kind=kind) or {"items": []})
    h, box = _handler()
    h._get_api("/local/next", {"project": ["/x"], "kind": ["review"]})
    assert seen == {"project": "/x", "kind": "review"}
    assert box["code"] == 200


def test_get_rejects_an_unknown_kind():
    h, box = _handler()
    h._get_api("/local/next", {"kind": ["haruspicy"]})
    assert box["code"] == 400


def test_post_refreshes_the_named_scope(monkeypatch):
    seen = {}
    monkeypatch.setattr(nextup, "refresh",
                        lambda chat, project=None, kind="next":
                        seen.update(project=project, kind=kind))
    monkeypatch.setattr(dash, "Thread",
                        lambda target, args, daemon: type(
                            "T", (), {"start": lambda s: target(*args)})())
    h, box = _handler()
    h._post_api("/local/next", {"project": "/x", "kind": "polish"})
    assert seen == {"project": "/x", "kind": "polish"}
    assert box["obj"]["ok"] is True


def test_post_rejects_an_unknown_kind():
    h, box = _handler()
    h._post_api("/local/next", {"kind": "haruspicy"})
    assert box["code"] == 400


def test_dismiss_forwards_the_id_and_answers_with_the_board(monkeypatch):
    seen = []
    monkeypatch.setattr(nextup, "dismiss", lambda item_id: seen.append(item_id))
    h, box = _handler()
    h._post_api("/local/next/dismiss", {"id": "abc-next-0", "project": "/x"})
    assert seen == ["abc-next-0"]
    assert box["obj"]["ok"] is True


def test_dismiss_without_an_id_is_a_400():
    h, box = _handler()
    h._post_api("/local/next/dismiss", {})
    assert box["code"] == 400
