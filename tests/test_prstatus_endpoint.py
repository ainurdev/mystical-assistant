"""GET /local/github/pr/status on the dashboard, driven without sockets by
using the Handler.__new__ trick (as in test_breakdown_endpoint.py). The
caching and gh handling behind it are in test_prstatus.py.
Run: python3 -m pytest tests/test_prstatus_endpoint.py -q"""

import os

from bridge import config, prstatus
from bridge.dashboard import server as dash


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_pr_status_hands_branch_force_and_session_to_the_snapshot(monkeypatch):
    os.makedirs(os.path.join(config.BASE_PATH, "rl-proj"), exist_ok=True)
    seen = {}

    def fake(repo_dir, branch, *, force=False, session=""):
        seen.update(repo_dir=repo_dir, branch=branch, force=force, session=session)
        return {"pr": None, "pinged": [], "checked": 1.0}
    monkeypatch.setattr(prstatus, "snapshot", fake)
    h, box = _handler()

    h._get_api("/local/github/pr/status", {
        "project": ["rl-proj"], "branch": [" feat/x "], "force": ["1"], "session": ["s1"]})

    assert box == {"obj": {"pr": None, "pinged": [], "checked": 1.0}, "code": 200}
    assert seen == {"repo_dir": os.path.realpath(os.path.join(config.BASE_PATH, "rl-proj")),
                    "branch": "feat/x", "force": True, "session": "s1"}


def test_pr_status_without_force_or_session_reads_the_cache(monkeypatch):
    os.makedirs(os.path.join(config.BASE_PATH, "rl-proj"), exist_ok=True)
    seen = {}
    monkeypatch.setattr(prstatus, "snapshot", lambda d, b, *, force=False, session="":
                        seen.update(force=force, session=session) or {"pr": None})
    h, box = _handler()

    h._get_api("/local/github/pr/status", {"project": ["rl-proj"], "branch": ["feat/x"]})

    assert box["code"] == 200 and seen == {"force": False, "session": ""}


def test_pr_status_for_an_unknown_project_is_400():
    h, box = _handler()

    h._get_api("/local/github/pr/status", {"project": ["../../etc"], "branch": ["x"]})

    assert box["code"] == 400
