"""server._worktree / _worktree_cwd must ask git "is this branch already checked
out?" rather than probing one hardcoded path. A branch can live in exactly one
worktree, and the one that exists may not follow the bridge's naming convention:
Claude Code's native `<repo>/.claude/worktrees/<slug>`, a hand-made
`git worktree add`, or the project checkout itself. Regression test for opening a
session dying on `fatal: '<branch>' is already used by worktree at ...`.
Run: python -m pytest tests/test_worktree_reuse.py -v"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mkproject(name):
    """A repo under BASE_PATH with one commit, so branches can be created."""
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


def test_worktree_reuses_branch_checked_out_elsewhere():
    """The reported failure: the branch already had a worktree, just not at the
    bridge's path, so the path-only check missed it and `worktree add` refused."""
    name, d = _mkproject("wtreuse_native")
    _git(d, "branch", "feat/x")
    native = os.path.join(d, ".claude", "worktrees", "feat+x")
    _git(d, "worktree", "add", native, "feat/x")

    h, box = _handler()
    h._worktree({"project": name, "branch": "feat/x", "create": False})
    assert box["obj"]["ok"] is True, box["obj"]
    assert os.path.realpath(box["obj"]["path"]) == os.path.realpath(native)


def test_worktree_reuses_project_checkout_when_branch_is_current():
    """A branch checked out in the project itself can't be added as a worktree
    either — reuse the checkout instead of handing back git's fatal."""
    name, d = _mkproject("wtreuse_current")
    cur = subprocess.run(["git", "-C", d, "branch", "--show-current"],
                         capture_output=True, text=True).stdout.strip()
    h, box = _handler()
    h._worktree({"project": name, "branch": cur, "create": False})
    assert box["obj"]["ok"] is True, box["obj"]
    assert os.path.realpath(box["obj"]["path"]) == os.path.realpath(d)


def test_worktree_creates_at_the_managed_path_when_branch_is_free():
    """The untouched path: nothing has the branch, so a worktree is still added
    under the bridge's own root."""
    name, d = _mkproject("wtreuse_fresh")
    h, box = _handler()
    h._worktree({"project": name, "branch": "feat/z", "create": True})
    assert box["obj"]["ok"] is True, box["obj"]
    assert os.path.realpath(box["obj"]["path"]) == \
        os.path.realpath(dash._worktree_path(name, "feat/z"))
    assert box["obj"]["rel"].endswith("/feat-z")


def test_worktree_cwd_finds_worktree_outside_the_convention():
    """Once a session runs in a foreign worktree, the per-branch status/diff/commit
    calls must target that tree, not fall back to the project checkout."""
    name, d = _mkproject("wtreuse_cwd")
    _git(d, "branch", "feat/y")
    native = os.path.join(d, ".claude", "worktrees", "feat+y")
    _git(d, "worktree", "add", native, "feat/y")
    assert dash._worktree_cwd(name, "feat/y") == os.path.realpath(native)


def test_switched_worktree_is_not_reused_for_the_branch_it_is_named_after():
    """The dir at the managed path is named after a branch, not bound to it — a
    session can `git checkout` it onto another one. Reusing it then opens the new
    session on the wrong branch, so both the create call and the per-branch cwd
    must ignore it."""
    name, d = _mkproject("wtreuse_switched")
    _git(d, "branch", "staging")
    wt = dash._worktree_path(name, "staging")
    os.makedirs(os.path.dirname(wt), exist_ok=True)
    _git(d, "worktree", "add", wt, "staging")
    _git(wt, "checkout", "-q", "-b", "feat/other")   # session moved it off staging

    h, box = _handler()
    h._worktree({"project": name, "branch": "staging", "create": False})
    assert box["obj"]["ok"] is True, box["obj"]
    got = os.path.realpath(box["obj"]["path"])
    assert got != os.path.realpath(wt), "handed back the tree on feat/other"
    assert _branch_of(got) == "staging"
    # ...and status/diff/commit for staging must not target the switched tree.
    assert dash._worktree_cwd(name, "staging") != os.path.realpath(wt)


def _branch_of(cwd):
    return subprocess.run(["git", "-C", cwd, "branch", "--show-current"],
                          capture_output=True, text=True).stdout.strip()
