"""Hiding a project: POST /local/project/settings {"hidden": ...} keeps it out of
the sidebar, and the projects listing's `hidden` carries that to every browser.
The sidebar's virtual groups (Rivendell jobs, Shared) have no folder, yet hide
the same way: refused, the next poll put a hidden group straight back.
Socket-free via Handler.__new__ (mirrors test_project_name.py).
Run: python -m pytest tests/test_project_hide.py -v"""

from urllib.parse import parse_qs, urlparse

import pytest

from bridge import project_config
from bridge.dashboard import server as dash


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))


def _call(method, path, body=None):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    if method == "GET":
        u = urlparse(path)
        h._get_api(u.path, parse_qs(u.query))
    else:
        h._post_api(path, body)
    return box


@pytest.mark.parametrize("group", ["rivendell:jobs", "team:shared"])
def test_a_virtual_group_hides_and_shows_like_a_folder(group):
    r = _call("POST", "/local/project/settings", {"project": group, "hidden": True})
    assert r["code"] == 200 and r["obj"]["hidden"] is True
    assert group in _call("GET", "/local/projects")["obj"]["hidden"]
    _call("POST", "/local/project/settings", {"project": group, "hidden": False})
    assert group not in _call("GET", "/local/projects")["obj"]["hidden"]


def test_a_virtual_group_takes_nothing_but_hide():
    assert _call("POST", "/local/project/settings", {"project": "rivendell:jobs", "name": "Jobs"})["code"] == 400
    assert _call("POST", "/local/project/settings", {"project": "other:group", "hidden": True})["code"] == 400
    assert project_config.hidden_projects() == [] and project_config.names() == {}
