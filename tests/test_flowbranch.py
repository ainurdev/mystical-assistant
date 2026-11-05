"""flowbranch: BUILD never starts on the default branch, and only the flow's own
files move to the feature worktree. Run: python -m pytest tests/test_flowbranch.py -v"""

import os
import subprocess

import pytest

from bridge import config, flowbranch, store


def _git(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True, check=True).stdout.strip()


class Repo:
    def __init__(self, root):
        self.main = os.path.join(root, "proj")
        os.makedirs(self.main)
        _git(self.main, "init", "-q", "-b", "master")
        _git(self.main, "config", "user.email", "t@t")
        _git(self.main, "config", "user.name", "t")
        self.write("README.md")
        _git(self.main, "add", "-A")
        _git(self.main, "commit", "-qm", "init")
        self.start = self.rev("master")

    def path(self, name, base=None):
        return os.path.join(base or self.main, name)

    def write(self, name, base=None):
        with open(self.path(name, base), "w") as f:
            f.write(name)

    def rev(self, ref):
        return _git(self.main, "rev-parse", ref)

    def head_moved(self, ref):
        return self.rev(ref) != self.start

    def branch_of(self, cwd):
        return _git(cwd, "rev-parse", "--abbrev-ref", "HEAD")

    def dirty(self, cwd):
        return {l[3:] for l in _git(cwd, "status", "--porcelain", "-uall").splitlines()}

    def last_subject(self, cwd):
        return _git(cwd, "log", "-1", "--format=%s")


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path / "base"))
    return Repo(str(tmp_path))


@pytest.fixture
def repo_on_feature(repo):
    repo.wt = os.path.join(os.path.dirname(repo.main), "wt")
    _git(repo.main, "worktree", "add", "-q", "-b", "feat/y", repo.wt)
    return repo


def test_default_branch_gets_feature_worktree(repo):
    branch, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert branch == "feat/x" and co != repo.main and repo.branch_of(co) == "feat/x"
    assert co == os.path.join(config.BASE_PATH, ".worktrees", "proj", "feat-x")


def test_feature_worktree_is_reused(repo_on_feature):
    assert flowbranch.ensure_feature_branch({"cwd": repo_on_feature.wt}, "x") == ("feat/y", repo_on_feature.wt)


def test_work_cwd_wins_over_cwd(repo_on_feature):
    s = {"cwd": repo_on_feature.main, "work_cwd": repo_on_feature.wt}
    assert flowbranch.ensure_feature_branch(s, "x") == ("feat/y", repo_on_feature.wt)


def test_existing_feature_branch_worktree_is_found_again(repo):
    first = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.ensure_feature_branch({"cwd": repo.main}, "x") == first


def test_env_is_copied(repo):
    repo.write(".env")
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert os.path.isfile(os.path.join(co, ".env"))


def test_only_flow_files_move_and_master_untouched(repo):
    repo.write("GLOSSARY.md"); repo.write("other.txt")   # other.txt belongs to someone else
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.carry_and_commit(repo.main, co, [repo.path("GLOSSARY.md")], "x")
    assert repo.dirty(repo.main) == {"other.txt"} and repo.head_moved("master") is False
    assert repo.last_subject(co) == "docs: decisions from the x flow"
    assert os.path.isfile(repo.path("GLOSSARY.md", co)) and repo.dirty(co) == set()


def test_no_files_no_commit(repo):
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.carry_and_commit(repo.main, co, [], "x") is False


def test_nothing_to_stash_leaves_other_stashes_alone(repo):
    repo.write("mine.txt")
    _git(repo.main, "stash", "push", "-u", "-m", "someone else", "--", "mine.txt")
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.carry_and_commit(repo.main, co, [repo.path("README.md")], "x") is False
    assert "someone else" in _git(repo.main, "stash", "list")


def test_flow_files_reads_writes_since_and_keeps_checkout_only(repo, monkeypatch):
    inside, outside = repo.path("docs/a.md"), "/elsewhere/b.md"
    evs = [{"type": "tool", "name": "Write", "summary": inside, "ts": 10},
           {"type": "tool", "name": "Edit", "summary": inside[:5], "detail": inside, "ts": 11},
           {"type": "tool", "name": "Write", "summary": outside, "ts": 12},
           {"type": "tool", "name": "Read", "summary": repo.path("r.md"), "ts": 13},
           {"type": "tool", "name": "Write", "summary": repo.path("old.md"), "ts": 1},
           {"type": "tool_done", "ts": 14}]
    monkeypatch.setattr(store, "timed_events", lambda sid: evs)
    monkeypatch.setattr(store, "get_session", lambda sid: {"cwd": repo.main, "work_cwd": None})
    assert flowbranch.flow_files("sid", 5) == [inside]
