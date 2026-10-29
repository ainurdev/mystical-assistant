"""SYSTEM ▸ STORAGE routes, driven without sockets via the Handler.__new__ trick
(mirrors test_graph_endpoints.py). Run: python -m pytest tests/test_storage_endpoint.py -v"""

from bridge import storage
from bridge.dashboard import server as dash


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_get_storage_answers_the_scan(monkeypatch):
    monkeypatch.setattr(storage, "scan", lambda: {"projects": [], "move_files": [], "bytes": 0})
    h, box = _handler()
    h._get_api("/local/storage", {})
    assert box["code"] == 200 and box["obj"] == {"projects": [], "move_files": [], "bytes": 0}


def test_clear_passes_the_ticked_items_through(monkeypatch):
    got = {}
    monkeypatch.setattr(storage, "clear", lambda items, moves: got.update(items=items, moves=moves) or {"freed": 3, "errors": []})
    h, box = _handler()
    h._post_api("/local/storage/clear", {"clear": [{"project": "/a", "entries": ["x"]}], "move_files": ["/m"]})
    assert box["code"] == 200 and box["obj"] == {"freed": 3, "errors": []}
    assert got == {"items": [{"project": "/a", "entries": ["x"]}], "moves": ["/m"]}


def test_clear_refuses_a_body_of_the_wrong_shape(monkeypatch):
    monkeypatch.setattr(storage, "clear", lambda *a: (_ for _ in ()).throw(AssertionError("called")))
    for body in ({"clear": "all"}, {"clear": ["/a"]}, {"clear": [], "move_files": "/m"}):
        h, box = _handler()
        h._post_api("/local/storage/clear", body)
        assert box["code"] == 400, body
