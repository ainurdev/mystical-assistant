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
        out = subprocess.run(["git", "-C", cwd, "status", "--porcelain", "-uall"],
                             capture_output=True, text=True, check=True).stdout
        return {l[3:] for l in out.splitlines()}

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


def test_a_repo_with_no_commits_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path / "base"))
    main = tmp_path / "fresh"
    main.mkdir()
    _git(str(main), "init", "-q", "-b", "main")
    (main / "app.py").write_text("work nobody has committed yet")
    with pytest.raises(RuntimeError, match="no commits yet.*Commit once on main"):
        flowbranch.ensure_feature_branch({"cwd": str(main)}, "x")


def test_feature_worktree_is_reused(repo_on_feature):
    assert flowbranch.ensure_feature_branch({"cwd": repo_on_feature.wt}, "x") == ("feat/y", repo_on_feature.wt)


def test_work_cwd_wins_over_cwd(repo_on_feature):
    s = {"cwd": repo_on_feature.main, "work_cwd": repo_on_feature.wt}
    assert flowbranch.ensure_feature_branch(s, "x") == ("feat/y", repo_on_feature.wt)


def test_existing_feature_branch_worktree_is_found_again(repo):
    first = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.ensure_feature_branch({"cwd": repo.main}, "x") == first


def test_a_name_that_differs_only_by_case_is_the_branch_that_exists(repo):
    first = flowbranch.ensure_feature_branch({"cwd": repo.main}, "NRA-61-login", "fix")
    assert flowbranch.ensure_feature_branch({"cwd": repo.main}, "nra-61-login", "fix") == first   # a Mac's disk holds one


def test_a_type_the_repo_has_as_a_branch_goes_under_feat(repo):
    _git(repo.main, "branch", "docs")                        # git can't hold docs and docs/naming-rules
    branch, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "naming-rules", "docs")
    assert branch == "feat/naming-rules" and repo.branch_of(co) == "feat/naming-rules"


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
    os.makedirs(repo.path("docs")); repo.write("docs/a.md")
    evs = [{"type": "tool", "name": "Write", "summary": inside, "ts": 10},
           {"type": "tool", "name": "Edit", "summary": inside[:5], "detail": inside, "ts": 11},
           {"type": "tool", "name": "Write", "summary": outside, "ts": 12},
           {"type": "tool", "name": "Read", "summary": repo.path("r.md"), "ts": 13},
           {"type": "tool", "name": "Write", "summary": repo.path("old.md"), "ts": 1},
           {"type": "tool_done", "ts": 14}]
    monkeypatch.setattr(store, "timed_events", lambda sid: evs)
    monkeypatch.setattr(store, "get_session", lambda sid: {"cwd": repo.main, "work_cwd": None})
    assert flowbranch.flow_files("sid", 5) == [inside]


def test_flow_files_leaves_out_what_git_cannot_carry(repo, monkeypatch, capsys):
    os.makedirs(repo.path(".mystical/tickets/x"))
    with open(repo.path(".mystical/.gitignore"), "w") as f:
        f.write("*\n")
    repo.write(".mystical/tickets/x/01-é.md"); repo.write("GLOSSARY.md")
    os.remove(repo.path("README.md"))              # tracked, then deleted: a deletion to carry
    ticket, glossary, gone, readme = (repo.path(p) for p in
                                      (".mystical/tickets/x/01-é.md", "GLOSSARY.md", "gone.py", "README.md"))
    evs = [{"type": "tool", "name": "Write", "summary": p, "ts": 10} for p in (ticket, glossary, gone, readme)]
    monkeypatch.setattr(store, "timed_events", lambda sid: evs)
    monkeypatch.setattr(store, "get_session", lambda sid: {"cwd": repo.main, "work_cwd": None})
    assert flowbranch.flow_files("sid", 5) == [glossary, readme]
    err = capsys.readouterr().err
    assert f"[flowbranch] {ticket} stays out of the carry: ignored" in err
    assert f"[flowbranch] {gone} stays out of the carry: missing" in err


def test_files_already_committed_in_the_feature_checkout_are_nothing_to_carry(repo_on_feature):
    r = repo_on_feature
    r.write("GLOSSARY.md", r.wt)
    _git(r.wt, "add", "GLOSSARY.md"); _git(r.wt, "commit", "-qm", "g")
    assert flowbranch.carry_and_commit(r.wt, r.wt, [r.path("GLOSSARY.md", r.wt)], "x") is False


def test_pop_conflict_restores_files_and_raises(repo):
    repo.write("GLOSSARY.md")
    _git(repo.main, "add", "GLOSSARY.md"); _git(repo.main, "commit", "-qm", "g")
    repo.start = repo.rev("master")
    with open(repo.path("GLOSSARY.md"), "w") as f:
        f.write("flow edit")
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    with open(repo.path("GLOSSARY.md", co), "w") as f:   # dst already changes the same file
        f.write("someone else's edit")
    with pytest.raises(flowbranch.FlowBranchError):
        flowbranch.carry_and_commit(repo.main, co, [repo.path("GLOSSARY.md")], "x")
    assert open(repo.path("GLOSSARY.md")).read() == "flow edit"
    assert repo.dirty(repo.main) == {"GLOSSARY.md"} and _git(repo.main, "stash", "list") == ""
    assert repo.last_subject(co) == "g"


@pytest.mark.parametrize("title", ["v1.2..", "x.lock", "...", "a" * 39 + ".b", "", "Fix: the *thing*"])
def test_slug_is_always_a_valid_branch(title):
    s = flowbranch.feature_slug(title)
    assert s and subprocess.run(["git", "check-ref-format", "--branch", f"feat/{s}"]).returncode == 0
    assert not s.endswith((".", ".lock", "-"))


def test_slug_values():
    assert flowbranch.feature_slug("v1.2..") == "v1.2"
    assert flowbranch.feature_slug("x.lock") == "x"
    assert flowbranch.feature_slug("...") == "flow"
    assert flowbranch.feature_slug("") == "flow"


# --- the name: the agent's `type/short-name`, else the session's title, repaired ----

def test_a_long_name_is_cut_at_a_whole_word():
    assert flowbranch.feature_slug("Better Branch Naming Convention for Projects") == "better-branch-naming-convention-for"
    assert flowbranch.feature_slug("a" * 50) == "a" * 40                      # one long word: cut where it must be


@pytest.mark.parametrize("given, want", [
    ("fix/NRA-61-Login-Redirect", ("fix", "NRA-61-login-redirect")),         # lower case, but a task's key as written
    ("fix/nra-61-login-redirect", ("fix", "nra-61-login-redirect")),         # a repo may write its keys small
    ("Docs/Branch naming rules", ("docs", "branch-naming-rules")),
    ("feature/globe-prototype", ("feat", "globe-prototype")),                # not a Conventional Commits type
    ("globe-prototype", ("feat", "globe-prototype")),                        # no type given
    ("feat/ui/globe", ("feat", "ui-globe")),                                 # one level: git can't hold feat/ui and feat/ui/globe
    ("refactor/split-the-session-store-into-readers-and-writers", ("refactor", "split-the-session-store-into-readers-and")),
    ("feat/", None), ("", None), (None, None), ("fix/...", None),
])
def test_the_agents_name_is_a_type_and_a_short_name(given, want):
    assert flowbranch.branch_name(given) == want
    if want:
        assert subprocess.run(["git", "check-ref-format", "--branch", "/".join(want)]).returncode == 0


@pytest.mark.parametrize("title, want", [
    ("/design-first update modal redesign", "update-modal-redesign"),
    ("Design-First Update Modal Redesign", "update-modal-redesign"),         # the titler's wording of the same prompt
    ("/mattpocock-skills:grill-with-docs better branch names", "better-branch-names"),
    ("Run the arda project", "run-the-arda-project"),                        # no command in front: as it is
    ("/etc/hosts is wrong", "etc-hosts-is-wrong"),                           # a path, not a command
    ("/design-first", "flow"),
])
def test_a_title_loses_the_command_it_began_with(title, want):
    assert flowbranch.title_slug(title) == want


def test_subdir_of_main_gets_a_feature_worktree(repo):
    os.makedirs(repo.path("sub"))
    branch, co = flowbranch.ensure_feature_branch({"cwd": repo.path("sub")}, "x")
    assert branch == "feat/x" and repo.branch_of(co) == "feat/x"


def test_detached_linked_worktree_gets_a_feature_worktree(repo):
    wt = os.path.join(os.path.dirname(repo.main), "det")
    _git(repo.main, "worktree", "add", "-q", "--detach", wt)
    branch, co = flowbranch.ensure_feature_branch({"cwd": wt}, "x")
    assert branch == "feat/x" and co != wt and repo.branch_of(co) == "feat/x"


def _sha_list(repo):
    return _git(repo.main, "stash", "list", "--format=%H").split()


def test_leftover_same_message_stash_is_not_popped(repo):
    repo.write("OLD.md")
    _git(repo.main, "stash", "push", "-u", "-m", "mystical flow x", "--", "OLD.md")
    old = _sha_list(repo)
    repo.write("NEW.md")
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.carry_and_commit(repo.main, co, [repo.path("NEW.md")], "x")
    assert _git(co, "show", "--name-only", "--format=", "HEAD") == "NEW.md"
    assert _sha_list(repo) == old and not os.path.exists(repo.path("NEW.md"))
    assert not os.path.exists(repo.path("OLD.md"))


def test_two_files_one_conflicts_both_come_back(repo):
    for n in ("A.md", "B.md"):
        repo.write(n)
    _git(repo.main, "add", "-A"); _git(repo.main, "commit", "-qm", "ab")
    for n in ("A.md", "B.md", "C.md"):
        with open(repo.path(n), "w") as f:
            f.write("flow edit")
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    with open(repo.path("A.md", co), "w") as f:
        f.write("theirs")
    with pytest.raises(flowbranch.FlowBranchError):
        flowbranch.carry_and_commit(repo.main, co, [repo.path(n) for n in ("A.md", "B.md", "C.md")], "x")
    for n in ("A.md", "B.md", "C.md"):
        assert open(repo.path(n)).read() == "flow edit"
    assert _sha_list(repo) == []
    assert repo.dirty(co) == {"A.md"} and open(repo.path("A.md", co)).read() == "theirs"
    assert not os.path.exists(repo.path("C.md", co))


def test_a_subdir_cwd_carries_files_by_their_repo_path(repo):
    os.makedirs(repo.path("sub"))
    os.makedirs(repo.path("docs/adr"))
    repo.write("docs/adr/0001.md")
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.path("sub")}, "x")
    assert flowbranch.carry_and_commit(repo.path("sub"), co, [repo.path("docs/adr/0001.md")], "x")
    assert _git(co, "show", "--name-only", "--format=", "HEAD") == "docs/adr/0001.md"
    assert repo.head_moved("master") is False and repo.dirty(co) == set()


def test_a_failed_pop_keeps_dsts_own_edit_of_a_non_ascii_file(repo):
    _git(repo.main, "config", "core.quotePath", "true")     # git's default: "\303\251.md" in status
    repo.write("é.md")
    _git(repo.main, "add", "-A"); _git(repo.main, "commit", "-qm", "e")
    with open(repo.path("é.md"), "w") as f:
        f.write("flow edit")
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    with open(repo.path("é.md", co), "w") as f:
        f.write("theirs")
    with pytest.raises(flowbranch.FlowBranchError):
        flowbranch.carry_and_commit(repo.main, co, [repo.path("é.md")], "x")
    assert open(repo.path("é.md", co)).read() == "theirs" and open(repo.path("é.md")).read() == "flow edit"


# --- another flow's edit in the same file stays behind -------------------------

def _glossary(repo, ours_after=None, theirs=None):
    lines = [f"term {i}" for i in range(10)]
    with open(repo.path("GLOSSARY.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    _git(repo.main, "add", "-A")
    _git(repo.main, "commit", "-qm", "glossary")
    if ours_after is not None:
        lines[ours_after + 1:ours_after + 1] = ["**Live board**:", "The pinned message."]
    if theirs:
        lines += ["", "## PR review", "**Finding**:", "One problem a review names."]
    with open(repo.path("GLOSSARY.md"), "w") as f:
        f.write("\n".join(lines) + "\n")


def test_only_this_flows_hunks_move_and_the_other_flows_stay(repo):
    _glossary(repo, ours_after=2, theirs=True)
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    ours = {os.path.realpath(repo.path("GLOSSARY.md")): {"**Live board**:", "The pinned message."}}
    assert flowbranch.carry_and_commit(repo.main, co, [repo.path("GLOSSARY.md")], "x", ours=ours)
    moved = _git(co, "show", "HEAD:GLOSSARY.md")
    assert "**Live board**:" in moved and "## PR review" not in moved
    left = open(repo.path("GLOSSARY.md")).read()
    assert "## PR review" in left and "**Live board**:" not in left
    assert _git(repo.main, "diff", "--stat").count("GLOSSARY.md") == 1      # theirs still uncommitted there


def test_a_file_with_none_of_this_flows_changes_stays(repo, capsys):
    _glossary(repo, theirs=True)
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    ours = {os.path.realpath(repo.path("GLOSSARY.md")): {"something else"}}
    assert flowbranch.carry_and_commit(repo.main, co, [repo.path("GLOSSARY.md")], "x", ours=ours) is False
    assert "## PR review" in open(repo.path("GLOSSARY.md")).read()
    assert "GLOSSARY.md stays out of the carry: none of its changes are this flow's" in capsys.readouterr().err


def test_bash_heredocs_count_as_writes(repo, monkeypatch):
    g = repo.path("GLOSSARY.md")
    cmd2 = f"cat > {repo.path('docs.md')} <<EOF\nhello\nEOF\necho done"
    assert flowbranch.bash_writes(f"cd {repo.main} && cat >> GLOSSARY.md <<'EOF'\n## PR review\nEOF", "/x") == \
        [(g, "## PR review")]
    assert flowbranch.bash_writes(cmd2, "/x") == [(repo.path("docs.md"), "hello")]
    evs = [{"type": "tool", "name": "Bash", "summary": cmd2[:120], "detail": cmd2, "ts": 10},
           {"type": "tool", "name": "Bash", "summary": "cat >> /elsewhere/f <<EOF\nx\nEOF", "ts": 11}]
    monkeypatch.setattr(store, "timed_events", lambda sid: evs)
    monkeypatch.setattr(store, "get_session", lambda sid: {"cwd": repo.main, "work_cwd": None})
    assert flowbranch.written("sid", 5) == [repo.path("docs.md")]


def test_added_lines_reads_the_flows_inputs_from_the_transcript(repo, monkeypatch, tmp_path):
    import json
    from bridge import transcript_jsonl
    g, a = repo.path("GLOSSARY.md"), repo.path("a.md")
    recs = [{"type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
             "message": {"content": [{"type": "tool_use", "name": "Write", "input": {"file_path": a, "content": "old"}}]}},
            {"type": "assistant", "timestamp": "2026-11-10T10:00:00Z", "message": {"content": [
                {"type": "tool_use", "name": "Edit", "input": {"file_path": g, "new_string": "x\n\ny"}},
                {"type": "tool_use", "name": "MultiEdit", "input": {"file_path": g, "edits": [{"new_string": "z"}]}},
                {"type": "tool_use", "name": "Write", "input": {"file_path": a, "content": "new"}},
                {"type": "tool_use", "name": "Bash", "input": {"command": f"cat >> {g} <<'EOF'\n## PR review\nEOF"}}]}}]
    t = tmp_path / "t.jsonl"
    t.write_text("\n".join(json.dumps(r) for r in recs) + "\nnot json\n")
    monkeypatch.setattr(transcript_jsonl, "find_transcript", lambda cid: str(t) if cid == "c1" else None)
    monkeypatch.setattr(store, "get_session", lambda sid: {"cwd": repo.main, "claude_session_id": sid})
    since = 1794200000
    got = flowbranch.added_lines("c1", since)
    assert got == {os.path.realpath(g): {"x", "y", "z", "## PR review"}, os.path.realpath(a): {"new"}}
    assert flowbranch.added_lines("nope", since) is None
