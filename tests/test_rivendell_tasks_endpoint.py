"""The RIVENDELL tab's two dashboard routes.

Socket-free via Handler.__new__ (the test_tracker_endpoints.py pattern). What is
under test is the wiring: a project resolves to its checkout's origin slug
before Rivendell is asked, a checkout without one never reaches Rivendell, and
IMPLEMENT's failures come back as the one line req() throws.
Run: python -m pytest tests/test_rivendell_tasks_endpoint.py -v"""

import os
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, rivendell  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def dget(path):
    h, box = _dash()
    u = urlparse(path)
    h._get_api(u.path, parse_qs(u.query))
    return box


def dpost(path, body):
    h, box = _dash()
    h._post_api(path, body)
    return box


def _repo(tmp_path, origin=None):
    d = os.path.join(config.BASE_PATH, tmp_path.name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    if origin:
        subprocess.run(["git", "-C", d, "remote", "add", "origin", origin], check=True)
    return tmp_path.name


@pytest.fixture
def asked(monkeypatch):
    """rivendell.tasks stubbed: the slugs it was asked for."""
    slugs = []

    def tasks(slug):
        slugs.append(slug)
        return {"instances": 1, "projects": [], "tasks": [{"id": "t1"}], "errors": []}
    monkeypatch.setattr(rivendell, "tasks", tasks)
    return slugs


def test_tasks_asks_rivendell_for_the_checkouts_origin(tmp_path, asked):
    rel = _repo(tmp_path, "git@github.com:Acme/App.git")
    r = dget(f"/local/rivendell/tasks?project={rel}")
    assert r["code"] == 200
    assert asked == ["Acme/App"]
    assert r["obj"]["slug"] == "Acme/App" and r["obj"]["tasks"] == [{"id": "t1"}]


def test_tasks_without_a_github_origin_never_reaches_rivendell(tmp_path, asked):
    rel = _repo(tmp_path)
    r = dget(f"/local/rivendell/tasks?project={rel}")
    assert r["code"] == 200 and r["obj"]["slug"] is None
    assert r["obj"]["tasks"] == [] and asked == []


def test_tasks_rejects_a_project_outside_the_workspace(asked):
    r = dget("/local/rivendell/tasks?project=../../etc")
    assert r["code"] == 400 and asked == []


def test_implement_relays_to_the_instance(monkeypatch):
    calls = []
    monkeypatch.setattr(rivendell, "implement",
                        lambda iid, tid: calls.append((iid, tid)) or {"id": "r7", "status": "PENDING"})
    r = dpost("/local/rivendell/implement", {"instance_id": "a", "task_id": "t1"})
    assert calls == [("a", "t1")]
    assert r["code"] == 200 and r["obj"] == {"ok": True, "request": {"id": "r7", "status": "PENDING"}}


def test_implement_needs_both_ids(monkeypatch):
    monkeypatch.setattr(rivendell, "implement",
                        lambda iid, tid: pytest.fail("must not be called"))
    assert dpost("/local/rivendell/implement", {"instance_id": "a"})["code"] == 400


def test_implement_failure_is_the_line_req_throws(monkeypatch):
    def refuse(iid, tid):
        raise rivendell.TasksError("refused", "No repository is linked to this task's project.")
    monkeypatch.setattr(rivendell, "implement", refuse)
    r = dpost("/local/rivendell/implement", {"instance_id": "a", "task_id": "t1"})
    assert r["code"] == 400
    assert r["obj"] == {"error": "No repository is linked to this task's project.", "code": "refused"}


def test_implement_on_an_unreachable_rivendell_is_a_bad_gateway(monkeypatch):
    def down(iid, tid):
        raise rivendell.TasksError("unreachable", "unreachable: connection refused")
    monkeypatch.setattr(rivendell, "implement", down)
    assert dpost("/local/rivendell/implement", {"instance_id": "a", "task_id": "t1"})["code"] == 502
