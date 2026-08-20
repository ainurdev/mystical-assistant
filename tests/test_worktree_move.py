"""Moving the session you are in into a fresh worktree.

The chat's "Move to a new worktree" row is two calls the dashboard already had —
create the worktree, then relocate the session — but nothing had ever run them
back to back, and the second one only lands if it resolves the same tree the
first one made. That is the join this pins.

Run: python -m pytest tests/test_worktree_move.py -v
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()


def _git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mkproject(name):
    d = os.path.join(config.BASE_PATH, name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    _git(d, "config", "user.email", "t@example.com")
    _git(d, "config", "user.name", "Tester")
    _git(d, "config", "commit.gpgsign", "false")
    open(os.path.join(d, "f.txt"), "w").close()
    _git(d, "add", "-A")
    _git(d, "commit", "-m", "init")
    return name, d


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_session_moves_into_the_worktree_it_just_cut():
    name, d = _mkproject("wtmove_proj")
    s = store.create_session(config.DASH_CHAT_ID, name, cwd=d)
    h, box = _handler()

    h._worktree({"project": name, "branch": "wt/move-me", "create": True})
    assert box["obj"]["ok"] is True, box["obj"]
    wt = os.path.realpath(box["obj"]["path"])

    h._post_api(f"/local/sessions/{s['id']}/relocate",
                {"project": name, "branch": "wt/move-me"})
    assert box["obj"]["ok"] is True, box["obj"]
    # The session's next turn runs in the new tree, not the checkout it started in.
    assert store.get_session(s["id"])["cwd"] == wt
    assert os.path.realpath(box["obj"]["cwd"]) == wt
    assert wt != os.path.realpath(d)


def test_moving_twice_lands_in_two_different_trees():
    """The branch name is derived from the session title, so a second move has to
    pick a free name — the client does that against the branch list. Here: two
    names, two trees, and the session ends up in the second one."""
    name, d = _mkproject("wtmove_twice")
    s = store.create_session(config.DASH_CHAT_ID, name, cwd=d)
    h, box = _handler()
    seen = []
    for branch in ("wt/fix-it", "wt/fix-it-2"):
        h._worktree({"project": name, "branch": branch, "create": True})
        assert box["obj"]["ok"] is True, box["obj"]
        seen.append(os.path.realpath(box["obj"]["path"]))
        h._post_api(f"/local/sessions/{s['id']}/relocate",
                    {"project": name, "branch": branch})
        assert box["obj"]["ok"] is True, box["obj"]
    assert seen[0] != seen[1]
    assert store.get_session(s["id"])["cwd"] == seen[1]
