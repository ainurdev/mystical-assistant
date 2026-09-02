"""Naming a project: POST /local/project/settings {"name": ...} renames it for
display only, and both the projects listing and the active-project label read
that name back. Driven without sockets via the Handler.__new__ trick (mirrors
test_design_endpoints.py).
Run: python -m pytest tests/test_project_name.py -v"""

import os
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import browser, config, project_config, state  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


class _Client:
    def get(self, path):
        h, box = _handler()
        u = urlparse(path)
        h._get_api(u.path, parse_qs(u.query))
        return box["obj"]

    def post(self, path, body):
        h, box = _handler()
        h._post_api(path, body)
        return box["obj"]


@pytest.fixture
def client():
    return _Client()


@pytest.fixture
def tmp_repo(tmp_path, monkeypatch):
    # A fresh store per test — conftest pins project_config._PATH process-wide,
    # so a name set here would otherwise leak into the next test.
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    d = os.path.join(config.BASE_PATH, tmp_path.name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    return d


def test_rename_shows_up_in_the_listing_and_the_active_label(client, tmp_repo, monkeypatch):
    rel = browser.rel(tmp_repo)
    assert client.get("/local/projects")["names"] == {}

    body = client.post("/local/project/settings", {"cwd": tmp_repo, "name": "Efas API"})
    assert body["name"] == "Efas API"
    assert client.get("/local/projects")["names"][rel] == "Efas API"
    assert client.get(f"/local/project/settings?cwd={tmp_repo}")["name"] == "Efas API"

    # The active project reports the given name where the directory name went.
    monkeypatch.setattr(state, "project_dir", lambda chat: tmp_repo)
    st = client.get("/local/state")
    assert st["project"] == {"rel": rel, "name": "Efas API"}

    # Display only: the rel path is untouched, so nothing on disk moved.
    assert os.path.isdir(tmp_repo)


def test_blank_name_falls_back_to_the_directory(client, tmp_repo, monkeypatch):
    client.post("/local/project/settings", {"cwd": tmp_repo, "name": "Efas API"})
    assert client.post("/local/project/settings", {"cwd": tmp_repo, "name": ""})["name"] is None
    monkeypatch.setattr(state, "project_dir", lambda chat: tmp_repo)
    assert client.get("/local/state")["project"]["name"] == os.path.basename(tmp_repo)
    assert client.get("/local/projects")["names"] == {}
