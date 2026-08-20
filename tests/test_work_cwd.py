"""A session whose shell walks into a worktree gets labelled with that worktree's
branch. Three layers, one file: the `cd` parser (git.shell_cd_target), the
worktree check against a real repo (git.is_worktree_of), and the runner hook that
writes it (runner._note_work_cwd) — plus what _session_brief then serves.

Real git here, not a stub: the whole point of is_worktree_of is that git, not the
path shape, decides what a worktree is. Env pinning lives in conftest."""

import os
import shutil
import subprocess
import tempfile

import pytest

from bridge import git, runner, store
from bridge.miniapp.server import _session_brief

store.init()


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, text=True)


@pytest.fixture
def repo():
    """A repo on master with a linked worktree on feat/x, plus a bare directory
    that is not a worktree at all."""
    root = tempfile.mkdtemp()
    proj = os.path.join(root, "proj")
    os.makedirs(proj)
    _git(proj, "init", "-q", "-b", "master")
    _git(proj, "config", "user.email", "t@t.t")
    _git(proj, "config", "user.name", "t")
    open(os.path.join(proj, "f.txt"), "w").write("x")
    _git(proj, "add", "f.txt")
    _git(proj, "commit", "-qm", "init")
    wt = os.path.join(root, "wt-feat-x")
    _git(proj, "worktree", "add", "-q", "-b", "feat/x", wt)
    outsider = os.path.join(root, "outsider")
    os.makedirs(outsider)
    yield {"root": root, "proj": proj, "wt": wt, "outsider": outsider}
    shutil.rmtree(root, ignore_errors=True)


# --- the cd parser -------------------------------------------------------

@pytest.mark.parametrize("cmd,want", [
    ("cd /a/b && git status", "/a/b"),
    ("git status", ""),
    ("cd /a/b && cd /c/d && ls", "/c/d"),       # last cd wins: that's where it runs
    ("cd '/a b/c' && ls", "/a b/c"),            # quoted path with a space
    ('cd "/a b/c" && ls', "/a b/c"),
    ("ls && cd /a/b", "/a/b"),                  # not just at the start
    ("cd /a/b; git log", "/a/b"),               # ; and || separate too
    ("false || cd /a/b", "/a/b"),
    ("echo hi\ncd /a/b\nls", "/a/b"),           # multi-line scripts
    ("cd -- /a/b && ls", "/a/b"),
    ("cd src && ls", ""),                       # relative: unresolvable, so ignored
    ("cd ..", ""),
    ("grep -rn 'cd /a/b' .", ""),               # a mention is not a move
    ("", ""),
])
def test_shell_cd_target(cmd, want):
    assert git.shell_cd_target(cmd) == want


def test_shell_cd_target_expands_home():
    assert git.shell_cd_target("cd ~/x && ls") == os.path.expanduser("~/x")


# --- git is the source of truth on what's a worktree ---------------------

def test_is_worktree_of(repo):
    assert git.is_worktree_of(repo["proj"], repo["wt"])
    assert git.is_worktree_of(repo["proj"], repo["proj"])   # the main tree counts
    assert not git.is_worktree_of(repo["proj"], repo["outsider"])
    assert not git.is_worktree_of(repo["proj"], "")


# --- the runner hook -----------------------------------------------------

def _job(sid, cwd):
    j = runner.Job("job-1", 555, store_session_id=sid)
    j.cwd = cwd
    return j


def test_note_work_cwd_follows_and_returns(repo):
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    job = _job(s["id"], repo["proj"])

    runner._note_work_cwd(job, f"cd {repo['wt']} && git commit -am x")
    assert store.get_session(s["id"])["work_cwd"] == repo["wt"]
    assert _session_brief(store.get_session(s["id"]))["branch"] == "feat/x"

    # ...and back home clears it, rather than leaving a stale worktree label.
    runner._note_work_cwd(job, f"cd {repo['proj']} && git status")
    assert store.get_session(s["id"])["work_cwd"] is None
    assert _session_brief(store.get_session(s["id"]))["branch"] == "master"


def test_note_work_cwd_ignores_non_worktrees(repo):
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    job = _job(s["id"], repo["proj"])
    for cmd in (f"cd {repo['outsider']} && ls", "cd /nope/nope && ls",
                "cd src && ls", "git -C /somewhere status"):
        runner._note_work_cwd(job, cmd)
        assert store.get_session(s["id"])["work_cwd"] is None, cmd


def test_brief_falls_back_when_the_worktree_is_gone(repo):
    """A removed worktree must not blank the label — the checkout answers, and
    work_cwd goes out as None so nothing marks a branch it can't see."""
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    store.set_work_cwd(s["id"], repo["wt"])
    _git(repo["proj"], "worktree", "remove", "--force", repo["wt"])
    git._branch_cache.clear()
    brief = _session_brief(store.get_session(s["id"]))
    assert brief["branch"] == "master"
    assert brief["work_cwd"] is None


def test_relocate_clears_the_detour(repo):
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    store.set_work_cwd(s["id"], repo["wt"])
    store.relocate(s["id"], repo["wt"])
    assert store.get_session(s["id"])["work_cwd"] is None
