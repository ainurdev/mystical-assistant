"""The task tab's route (docs/superpowers/specs/rivendell-task-check.md): GET
reads the branch's state for its checkout, POST records NOT A TASK there.
Socket-free via Handler.__new__ (the test_rivendell_tasks_endpoint.py pattern).
What is under test is the wiring: the project and branch resolve to the
checkout, the RIVENDELL TASKS switch hides the tab, and a skip lands on the
branch actually checked out.
Run: python -m pytest tests/test_rivendell_taskstate_endpoint.py -v"""

import os
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, config, rivendell, taskcheck  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _call(fn, *a):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    getattr(h, fn)(*a)
    return box


def dget(path):
    u = urlparse(path)
    return _call("_get_api", u.path, parse_qs(u.query))


def dpost(body):
    return _call("_post_api", "/local/rivendell/taskstate", body)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A checkout in the workspace on fix/login; task_state echoes the folder it got."""
    d = os.path.join(config.BASE_PATH, tmp_path.name)
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    subprocess.run(["git", "-C", d, "checkout", "-q", "-b", "fix/login"], check=True)
    monkeypatch.setattr(rivendell, "task_state", lambda cwd: {"state": "none", "cwd": cwd})
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "rvtrack")
    return tmp_path.name, d


def test_get_reads_the_branchs_checkout(repo):
    rel, d = repo
    r = dget(f"/local/rivendell/taskstate?project={rel}&branch=fix/login")
    assert r["code"] == 200 and r["obj"]["task"] == {"state": "none", "cwd": d}


def test_get_draws_nothing_while_the_switch_is_off(repo, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    assert dget(f"/local/rivendell/taskstate?project={repo[0]}&branch=fix/login")["obj"] == {"task": None}


def test_get_rejects_a_project_outside_the_workspace(repo):
    assert dget("/local/rivendell/taskstate?project=../../etc&branch=x")["code"] == 400


def test_post_records_not_a_task_for_the_branch(repo):
    rel, d = repo
    r = dpost({"project": rel, "branch": "fix/login", "state": "skip"})
    assert r["code"] == 200 and r["obj"]["task"]["cwd"] == d
    assert taskcheck.read(taskcheck.toplevel(d)) == {"fix/login": "skip"}


@pytest.mark.parametrize("body,code", [
    ({"branch": "fix/login", "state": "linked"}, 400),     # only NOT A TASK is the tab's to say
    ({"branch": "fix/other", "state": "skip"}, 409),       # not the branch checked out there
    ({"branch": "", "state": "skip"}, 409),
])
def test_post_refuses_anything_but_a_skip_of_the_checked_out_branch(repo, body, code):
    rel, d = repo
    assert dpost({"project": rel, **body})["code"] == code
    assert taskcheck.read(d) == {}
