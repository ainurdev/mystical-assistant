"""Splitting a held prompt into a new session keeps its branch.

The "different work?" guardrail offers a fresh session for a prompt that doesn't
belong in the one it landed in. That offshoot must run where the held session ran
— a linked worktree, on its branch — not in the project's main checkout. The
dashboard already honoured an explicit cwd on session-create; this pins that and
the Mini App's matching behaviour.

Run: python -m pytest tests/test_new_session_cwd.py -v
"""

import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from bridge import config, state, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402

store.init()

CHAT = 555
PROJ = "nsc_proj"


@pytest.fixture()
def dirs():
    """A project checkout and a linked worktree for it, both inside BASE_PATH."""
    proj = os.path.join(config.BASE_PATH, PROJ)
    wt = os.path.join(config.BASE_PATH, ".worktrees", PROJ, "feat-x")
    os.makedirs(proj, exist_ok=True)
    os.makedirs(wt, exist_ok=True)
    state.active[CHAT] = proj
    try:
        yield os.path.realpath(proj), os.path.realpath(wt)
    finally:
        shutil.rmtree(proj, ignore_errors=True)
        shutil.rmtree(os.path.join(config.BASE_PATH, ".worktrees"), ignore_errors=True)
        state.active.pop(CHAT, None)


def _mini(body):
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._api_sessions_create(CHAT, body)
    return store.get_session(box["obj"]["session"]["id"])


def test_miniapp_new_session_runs_in_the_given_worktree(dirs):
    _proj, wt = dirs
    assert _mini({"project": PROJ, "cwd": wt, "title": "Add CSV Export"})["cwd"] == wt


def test_miniapp_new_session_without_a_cwd_uses_the_project(dirs):
    proj, _wt = dirs
    assert _mini({"project": PROJ})["cwd"] == proj


def test_miniapp_rejects_a_cwd_outside_the_workspace(dirs):
    proj, _wt = dirs
    assert _mini({"project": PROJ, "cwd": "/etc"})["cwd"] == proj


def test_dashboard_new_session_runs_in_the_given_worktree(dirs):
    _proj, wt = dirs
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._post_api("/local/sessions", {"project": PROJ, "cwd": wt})
    assert store.get_session(box["obj"]["session"]["id"])["cwd"] == wt
