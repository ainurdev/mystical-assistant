"""Dashboard + miniapp graph endpoints, driven without sockets via the
Handler.__new__ trick (mirrors test_files_endpoints.py).
Run: python -m pytest tests/test_graph_endpoints.py -v"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, graphmap  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _mkproject(name):
    d = os.path.join(config.BASE_PATH, name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    return name, d


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send = lambda data, code, ctype, cache="no-cache": box.update(
        data=data, code=code, ctype=ctype)
    return h, box


def test_graph_state_endpoint(monkeypatch):
    name, d = _mkproject("proj_gstate")
    h, box = _handler()
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {"exists": False,
        "available": True, "built_commit": None, "head": None,
        "stale": False, "building": False})
    h._get_api("/local/graph/state", {"project": [name]})
    assert box["code"] == 200 and box["obj"]["exists"] is False


def test_graph_state_invalid_project():
    h, box = _handler()
    h._get_api("/local/graph/state", {"project": ["../../etc"]})
    assert box["code"] == 400


def test_graph_html_serves_file():
    name, d = _mkproject("proj_ghtml")
    os.makedirs(os.path.join(d, graphmap.OUT_DIR), exist_ok=True)
    with open(os.path.join(d, graphmap.OUT_DIR, "graph.html"), "w") as f:
        f.write("<html>MAP</html>")
    h, box = _handler()
    h._get_api("/local/graph/html", {"project": [name]})
    assert box["code"] == 200 and b"MAP" in box["data"]
    assert box["ctype"].startswith("text/html")


def test_graph_html_404_when_missing():
    name, _d = _mkproject("proj_gnone")
    h, box = _handler()
    h._get_api("/local/graph/html", {"project": [name]})
    assert box["code"] == 404


def test_graph_explain_endpoint(monkeypatch):
    name, _d = _mkproject("proj_gexp")
    monkeypatch.setattr(graphmap, "explain", lambda _c, q: f"ANSWER {q}")
    h, box = _handler()
    h._get_api("/local/graph/explain", {"project": [name], "q": ["thing"]})
    assert box["obj"] == {"text": "ANSWER thing"}


def test_graph_update_endpoint(monkeypatch):
    name, _d = _mkproject("proj_gupd")
    monkeypatch.setattr(graphmap, "update_async", lambda _c: {"building": True,
        "available": True, "exists": False, "built_commit": None,
        "head": None, "stale": False})
    h, box = _handler()
    h._post_api("/local/graph/update", {"project": name})
    assert box["code"] == 200 and box["obj"]["building"] is True


# --- miniapp ------------------------------------------------------------------

from bridge.miniapp import server as mini  # noqa: E402


def _mini_handler():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send_bytes = lambda data, code, ctype, cache="no-cache": box.update(
        data=data, code=code, ctype=ctype)
    return h, box


def test_mini_graph_state(monkeypatch):
    name, _d = _mkproject("proj_mstate")
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {"exists": True,
        "available": True, "built_commit": "a", "head": "a",
        "stale": False, "building": False})
    h, box = _mini_handler()
    h._api_graph(555, "state", {"project": [name]}, None)
    assert box["obj"]["exists"] is True


def test_mini_graph_html(monkeypatch):
    name, d = _mkproject("proj_mhtml")
    os.makedirs(os.path.join(d, graphmap.OUT_DIR), exist_ok=True)
    with open(os.path.join(d, graphmap.OUT_DIR, "graph.html"), "w") as f:
        f.write("<html>M</html>")
    h, box = _mini_handler()
    h._api_graph(555, "html", {"project": [name]}, None)
    assert box["code"] == 200 and b"M" in box["data"]


def test_mini_graph_update(monkeypatch):
    name, _d = _mkproject("proj_mupd")
    monkeypatch.setattr(graphmap, "update_async", lambda _c: {"building": True})
    h, box = _mini_handler()
    h._api_graph(555, "update", {}, {"project": name})
    assert box["obj"]["building"] is True


def test_mini_graph_defaults_to_active_project(monkeypatch):
    _name, d = _mkproject("proj_mdflt")
    monkeypatch.setattr(mini.state, "project_dir", lambda _c: d)
    monkeypatch.setattr(graphmap, "graph_state", lambda cwd: {"cwd": cwd})
    h, box = _mini_handler()
    h._api_graph(555, "state", {}, None)
    assert box["obj"]["cwd"] == d
