"""A session whose shell walks into a worktree — or that makes one for its change —
gets labelled with that worktree's branch. Three layers, one file: the `cd`
parser (git.shell_cd_target), the worktree lookups against a real repo
(git.is_worktree_of, git.worktree_holding), and the runner hook that writes it
(runner._note_work_cwd, judged on a Bash call's result) — plus what
_session_brief then serves.

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
    # Real path: git lists worktrees by it (/private/var… on a Mac), and that is
    # the path the hook records.
    root = os.path.realpath(tempfile.mkdtemp())
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


def test_worktree_holding(repo):
    sub = os.path.join(repo["wt"], "web", "src")
    os.makedirs(sub)
    assert git.worktree_holding(repo["proj"], repo["wt"]) == repo["wt"]
    assert git.worktree_holding(repo["proj"], sub) == repo["wt"]          # any depth
    assert git.worktree_holding(repo["proj"], repo["proj"]) == ""         # the checkout never answers
    assert git.worktree_holding(repo["proj"], repo["proj"] + "/.mystical") == ""
    assert git.worktree_holding(repo["proj"], repo["wt"] + "-2") == ""    # a sibling sharing the prefix
    assert git.worktree_holding(repo["proj"], repo["outsider"]) == ""
    assert git.worktree_holding(repo["proj"], "") == ""


def test_worktree_holding_finds_a_tree_nested_in_the_checkout(repo):
    """Claude Code's own worktrees sit inside the checkout (.claude/worktrees/):
    the checkout containing them must not shadow them."""
    nested = os.path.join(repo["proj"], ".claude", "worktrees", "n")
    _git(repo["proj"], "worktree", "add", "-q", "-b", "n", nested)
    assert git.worktree_holding(repo["proj"], os.path.join(nested, "x")) == nested


# --- the runner hook -----------------------------------------------------

def _job(sid, cwd):
    j = runner.Job("job-1", 555, store_session_id=sid)
    j.cwd = cwd
    return j


def test_note_work_cwd_follows_and_stays(repo):
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    job = _job(s["id"], repo["proj"])

    runner._note_work_cwd(job, f"cd {repo['wt']} && git commit -am x")
    assert store.get_session(s["id"])["work_cwd"] == repo["wt"]
    assert _session_brief(store.get_session(s["id"]))["branch"] == "feat/x"

    # The checkout is where probes, merges and reads of master happen
    # mid-feature: a cd there keeps the label on the branch, which used to flip
    # back and forth. The tree's removal is what hands it back (test below).
    for cmd in (f"cd {repo['proj']} && git status", f"cd {repo['proj']}/.mystical && node probe.mjs",
                f"cd {repo['proj']} && git merge feat/x"):
        runner._note_work_cwd(job, cmd)
        assert store.get_session(s["id"])["work_cwd"] == repo["wt"], cmd


def test_note_work_cwd_follows_a_cd_below_the_root(repo):
    """`cd <wt>/web/src && npm test` works on that tree's branch as much as
    `cd <wt>` does; the session takes the tree, not the folder."""
    sub = os.path.join(repo["wt"], "web", "src")
    os.makedirs(sub)
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    job = _job(s["id"], repo["proj"])
    runner._note_work_cwd(job, f"cd {sub} && npm test")
    assert store.get_session(s["id"])["work_cwd"] == repo["wt"]


def test_a_session_on_a_worktree_comes_home_from_any_depth(repo):
    """Started on a worktree, that tree is home: entering it again, from any
    depth, takes the session back from another tree. The checkout never does."""
    s = store.create_session(555, "/proj", origin="test", cwd=repo["wt"])
    job = _job(s["id"], repo["wt"])
    runner._note_work_cwd(job, f"cd {repo['proj']} && git merge feat/x")
    assert store.get_session(s["id"])["work_cwd"] is None
    wt2 = os.path.join(repo["root"], "wt-feat-y")
    _git(repo["proj"], "worktree", "add", "-q", "-b", "feat/y", wt2)
    runner._note_work_cwd(job, f"cd {wt2} && git status")
    assert store.get_session(s["id"])["work_cwd"] == wt2
    runner._note_work_cwd(job, f"cd {repo['wt']}/web && npm test")
    assert store.get_session(s["id"])["work_cwd"] is None


def test_a_tree_the_command_made_is_where_the_session_works(repo):
    """A session starts on master and branches off for its change: the worktree
    its command added is its branch from then on — with no `cd` into it, and
    even when the same line went home first."""
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    job = _job(s["id"], repo["proj"])
    before = {w["path"] for w in git.worktrees(repo["proj"])}
    wt = os.path.join(repo["root"], "wt-feat-y")
    _git(repo["proj"], "worktree", "add", "-q", "-b", "feat/y", wt)   # the command ran
    runner._note_work_cwd(job, f"cd {repo['proj']} && WT={wt}; git worktree add -q -b feat/y $WT", before)
    assert store.get_session(s["id"])["work_cwd"] == wt
    assert _session_brief(store.get_session(s["id"]))["branch"] == "feat/y"


def test_a_bash_call_is_judged_on_its_result(repo):
    """`git worktree add … && cd …` names a tree that only exists once the line
    has run, so the call can't place the session; its result does."""
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    job = _job(s["id"], repo["proj"])
    wt = os.path.join(repo["root"], "wt-feat-y")
    cmd = f"git worktree add -q -b feat/y {wt} && cd {wt} && git status"
    runner._handle_event(job, {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": cmd}}]}})
    assert store.get_session(s["id"])["work_cwd"] is None
    _git(repo["proj"], "worktree", "add", "-q", "-b", "feat/y", wt)   # the CLI runs it
    runner._handle_event(job, {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}})
    assert store.get_session(s["id"])["work_cwd"] == wt


def test_a_later_turn_starts_on_the_sessions_tree(repo, monkeypatch):
    """A new turn's job carries the session's tree: a Task card answered in it is
    recorded for that branch, and coming home in a later turn is a change to
    record (a job that started blank saw none)."""
    from bridge import state, titler
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    store.set_work_cwd(s["id"], repo["wt"])
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming", lambda *a: None)

    def turn():
        job = runner.start_streaming_job(555, "go", [], project=repo["proj"], session_id=s["id"])
        state.release_run(s["id"])
        return job

    assert turn().work_cwd == repo["wt"]
    # A tree removed since is not one to start on (a Task card answered there
    # would be recorded nowhere).
    store.set_work_cwd(s["id"], os.path.join(repo["root"], "gone"))
    assert turn().work_cwd is None


def test_note_work_cwd_ignores_non_worktrees(repo):
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    job = _job(s["id"], repo["proj"])
    for cmd in (f"cd {repo['outsider']} && ls", "cd /nope/nope && ls",
                "cd src && ls", "git -C /somewhere status"):
        runner._note_work_cwd(job, cmd)
        assert store.get_session(s["id"])["work_cwd"] is None, cmd


def test_a_branch_made_in_the_checkout_needs_no_hook(repo):
    """`git checkout -b` in the session's own checkout: the brief reads the
    checkout's branch on every poll (through a 3 s cache)."""
    s = store.create_session(555, "/proj", origin="test", cwd=repo["proj"])
    _git(repo["proj"], "checkout", "-q", "-b", "feat/z")
    git._branch_cache.clear()
    assert _session_brief(store.get_session(s["id"]))["branch"] == "feat/z"


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
