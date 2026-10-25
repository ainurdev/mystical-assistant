"""The push gate and each branch's task answer (bridge/taskcheck.py,
docs/superpowers/specs/rivendell-task-check.md). What matters: a push from the
board repo that carries no task key is held exactly once per branch; a key
anywhere Rivendell or a reader would see it lets the push through; and nothing
outside the board repo, or that isn't a push, is ever held.
Run: python -m pytest tests/test_taskcheck.py -v"""

import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from bridge import taskcheck  # noqa: E402

PUSH = "git push -u origin HEAD"


def git(d, *a):
    return subprocess.run(["git", "-C", d, *a], check=True, capture_output=True, text=True).stdout.strip()


def make_repo(path, remote):
    subprocess.run(["git", "init", "-q", "-b", "main", path], check=True)
    git(path, "config", "user.email", "t@t")
    git(path, "config", "user.name", "t")
    git(path, "commit", "-q", "--allow-empty", "-m", "init")
    git(path, "remote", "add", "origin", remote)
    git(path, "push", "-q", "origin", "main")


@pytest.fixture
def repo(tmp_path):
    """A checkout on fix/login with one commit no remote has yet."""
    remote = str(tmp_path / "remote.git")
    subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
    d = str(tmp_path / "app")
    make_repo(d, remote)
    git(d, "checkout", "-q", "-b", "fix/login")
    git(d, "commit", "-q", "--allow-empty", "-m", "fix the login redirect")
    return d


def held(repo, command=PUSH, cwd=None, prefixes=("NRA",)):
    return taskcheck.gate(cwd or repo, command, taskcheck.repo_id(repo), prefixes)


def test_a_keyless_push_is_held_once_per_branch(repo):
    msg = held(repo)
    assert msg and "Task" in msg
    assert held(repo) is None                       # the retry goes through
    assert taskcheck.read(taskcheck.toplevel(repo)) == {"fix/login": "asked"}
    git(repo, "checkout", "-q", "-b", "fix/other")
    assert held(repo)                               # a new branch is new work


@pytest.mark.parametrize("how", ["branch", "lowercase branch", "pr title", "commit", "recorded key", "skip"])
def test_a_task_key_or_an_answer_lets_the_push_through(repo, how):
    command = PUSH
    if how == "branch":
        git(repo, "branch", "-m", "fix/NRA-61-login")
    elif how == "lowercase branch":
        git(repo, "branch", "-m", "fix/nra-61-login")   # Rivendell matches keys in any case
    elif how == "pr title":
        command = 'gh pr create --title "NRA-61 fix the login redirect" --body x'
    elif how == "commit":
        git(repo, "commit", "-q", "--allow-empty", "-m", "NRA-61: and the logout one")
    elif how == "recorded key":
        taskcheck.record(repo, "fix/login", "NRA-61")
    else:
        taskcheck.record(repo, "fix/login", "skip")
    assert held(repo, command) is None


@pytest.mark.parametrize("command", [
    "git status", "git log --grep push", "echo git push", "grep -r 'git push' .",
    "git push --delete origin fix/login", "git push origin :fix/login", "git push --tags",
])
def test_only_pushes_of_work_are_gated(repo, command):
    assert held(repo, command) is None
    assert taskcheck.read(repo) == {}


@pytest.mark.parametrize("form", ["-C", "cd", "env", "chain", "gh"])
def test_every_way_of_spelling_a_push(repo, tmp_path, form):
    elsewhere = str(tmp_path)
    command, cwd = {
        "-C": (f"git -C {repo} push", elsewhere),
        "cd": (f"cd {repo} && git push origin HEAD", elsewhere),
        "env": ("GIT_TRACE=0 git push", repo),
        "chain": ("npm test && git add -A && git commit -m x; git push", repo),
        "gh": ("gh pr create --fill", repo),
    }[form]
    assert held(repo, command, cwd=cwd)


def test_a_push_from_another_repo_is_never_held(repo, tmp_path):
    other = str(tmp_path / "other")
    remote = str(tmp_path / "other.git")
    subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
    make_repo(other, remote)
    assert held(repo, cwd=other) is None


def test_a_linked_worktree_of_the_board_repo_is_gated(repo, tmp_path):
    wt = str(tmp_path / "wt")
    git(repo, "worktree", "add", "-q", "-b", "feat/x", wt)
    git(wt, "commit", "-q", "--allow-empty", "-m", "x")
    assert held(repo, cwd=wt)
    assert taskcheck.read(wt) == {"feat/x": "asked"}


def test_a_detached_head_is_not_gated(repo):
    git(repo, "checkout", "-q", "--detach")
    assert held(repo) is None


def test_asked_never_undoes_an_answer(repo):
    taskcheck.record(repo, "fix/login", "skip")
    taskcheck.record(repo, "fix/login", "asked")
    assert taskcheck.read(repo) == {"fix/login": "skip"}


def on_main(repo):
    """The checkout back on main, tracking origin/main, with a commit no remote has."""
    git(repo, "checkout", "-q", "main")
    git(repo, "branch", "-q", "-u", "origin/main")
    git(repo, "commit", "-q", "--allow-empty", "-m", "tweak the footer")


def land(repo, then="the next piece of work"):
    """Push main, then start the next piece of work on it."""
    git(repo, "push", "-q", "origin", "main")
    git(repo, "commit", "-q", "--allow-empty", "-m", then)


def test_a_push_from_main_is_held_once_per_piece_of_work(repo):
    on_main(repo)
    assert held(repo)
    assert held(repo) is None                       # the retry goes through
    land(repo)
    assert held(repo)                               # new work on main asks again


@pytest.mark.parametrize("value", ["skip", "EFA-68"])
def test_an_answer_on_main_covers_only_the_work_it_was_given_for(repo, value):
    on_main(repo)
    taskcheck.record(repo, "main", value)
    assert held(repo) is None
    land(repo)
    assert held(repo)


def test_a_fetch_keeps_an_answer_on_main(repo, tmp_path):
    on_main(repo)
    taskcheck.record(repo, "main", "skip")
    mate = str(tmp_path / "mate")
    subprocess.run(["git", "clone", "-q", git(repo, "remote", "get-url", "origin"), mate], check=True)
    git(mate, "-c", "user.email=m@m", "-c", "user.name=m", "commit", "-q", "--allow-empty", "-m", "theirs")
    git(mate, "push", "-q", "origin", "main")
    git(repo, "fetch", "-q")                        # a teammate's push, fetched in the background
    assert held(repo) is None


def test_an_answer_main_kept_forever_no_longer_counts_and_goes(repo):
    on_main(repo)
    os.makedirs(os.path.join(repo, ".mystical"))
    with open(os.path.join(repo, taskcheck.STATE), "w") as f:     # as it was written before
        json.dump({"main": "skip", "fix/login": "NRA-61"}, f)
    assert held(repo)
    d = taskcheck.read(repo)
    assert "main" not in d and d["fix/login"] == "NRA-61"
    assert [v for k, v in d.items() if k.startswith("main@")] == ["asked"]
    land(repo)
    assert held(repo)
    assert len([k for k in taskcheck.read(repo) if k.startswith("main@")]) == 1   # one answer per main


def test_a_feature_branch_keeps_its_answer_after_its_push(repo):
    taskcheck.record(repo, "fix/login", "skip")
    git(repo, "push", "-q", "-u", "origin", "fix/login")
    git(repo, "commit", "-q", "--allow-empty", "-m", "and the logout one")
    assert held(repo) is None
    assert taskcheck.read(repo) == {"fix/login": "skip"}


def test_the_default_branch_is_whatever_origin_names(repo):
    git(repo, "branch", "-q", "trunk", "main")
    git(repo, "push", "-q", "origin", "trunk")
    git(repo, "remote", "set-head", "origin", "trunk")
    git(repo, "checkout", "-q", "trunk")
    git(repo, "branch", "-q", "-u", "origin/trunk")
    assert taskcheck.slot(repo, "trunk").startswith("trunk@")
    assert taskcheck.slot(repo, "main") == "main"   # origin names trunk, so main is just a branch
    assert taskcheck.slot(repo, "fix/login") == "fix/login"


def test_the_answers_stay_out_of_git(repo):
    taskcheck.record(repo, "fix/login", "skip")
    assert git(repo, "status", "--porcelain") == ""


@pytest.mark.parametrize("label,want", [
    ("Not a task", "skip"),
    ("Not a task (Recommended)", "skip"),
    ("It's NRA-51 Office monitoring dashboard (Recommended)", "NRA-51"),
    ("it's nra-51 · Office monitoring dashboard", "NRA-51"),
    ("Create “Name every instructor in the complaint queue” (Recommended)", None),
])
def test_what_a_task_card_answer_decides(label, want):
    q = [{"header": "Task", "question": "Track it?", "options": []}]
    assert taskcheck.answer_state(q, [{"header": "Task", "labels": [label]}]) == want


def test_other_cards_decide_nothing():
    q = [{"header": "Deploy", "question": "Ship it?", "options": []}]
    assert taskcheck.answer_state(q, [{"header": "Deploy", "labels": ["Not a task"]}]) is None


def hook(repo, event):
    return subprocess.run([sys.executable, "-I", os.path.join(ROOT, "bridge", "taskcheck.py"),
                           taskcheck.repo_id(repo), "NRA"],
                          input=event if isinstance(event, str) else json.dumps(event),
                          capture_output=True, text=True, cwd=repo)


def test_the_hook_holds_a_push_by_exit_code_2_with_its_reason_on_stderr(repo):
    ev = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": repo,
          "tool_input": {"command": PUSH}}
    first = hook(repo, ev)
    assert first.returncode == 2 and "Task" in first.stderr
    assert hook(repo, ev).returncode == 0
    assert hook(repo, {**ev, "tool_name": "Read"}).returncode == 0
    assert hook(repo, "not json").returncode == 0      # a broken event never blocks work
