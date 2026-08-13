"""Dashboard design-routing endpoints: the design_project link on project
settings, and the /local/design/prompt route that composes what a run
executes. Driven without sockets via the Handler.__new__ trick (mirrors
test_graph_endpoints.py).
Run: python -m pytest tests/test_design_endpoints.py -v"""

import os
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, browser, config, project_config  # noqa: E402
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


class _Client:
    """Drives the GET/POST route tables the way do_GET/do_POST would, minus
    the socket — returns the JSON body a real request would receive."""

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
    # conftest.py pins BRIDGE_DB (and therefore project_config._PATH) once for
    # the whole test process, so tests sharing that store would otherwise leak
    # a design link into each other. Point project_config at a fresh file per
    # test instead — the in-process monkeypatch the task brief calls out.
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    _name, d = _mkproject(tmp_path.name)
    return d


def test_project_settings_reports_the_design_link(client, tmp_repo, monkeypatch):
    project_config.set_design_project(browser.rel(tmp_repo), "aaaa-1")
    body = client.get(f"/local/project/settings?cwd={tmp_repo}")
    assert body["design_project"] == "aaaa-1"


def test_project_settings_sets_the_design_link(client, tmp_repo):
    body = client.post("/local/project/settings",
                       {"cwd": tmp_repo, "design_project": "bbbb-2"})
    assert body["design_project"] == "bbbb-2"
    assert project_config.design_project(browser.rel(tmp_repo)) == "bbbb-2"


def test_design_prompt_is_refused_while_the_switch_is_off(client, tmp_repo, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda k: k != "design")
    body = client.get(f"/local/design/prompt?kind=link&cwd={tmp_repo}")
    assert body["error"] == "design system switch is off"


def test_pull_prompt_needs_a_link(client, tmp_repo, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda k: True)
    body = client.get(f"/local/design/prompt?kind=pull&cwd={tmp_repo}")
    assert body["error"] == "no design project linked"


def test_pull_prompt_carries_the_linked_id(client, tmp_repo, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda k: True)
    project_config.set_design_project(browser.rel(tmp_repo), "aaaa-1")
    body = client.get(f"/local/design/prompt?kind=pull&cwd={tmp_repo}")
    assert "aaaa-1" in body["prompt"]


def test_unknown_kind_is_rejected(client, tmp_repo, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda k: True)
    project_config.set_design_project(browser.rel(tmp_repo), "aaaa-1")
    body = client.get(f"/local/design/prompt?kind=teleport&cwd={tmp_repo}")
    assert body["error"] == "unknown kind"
