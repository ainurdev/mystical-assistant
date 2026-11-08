"""The pre-commit hook (.githooks/pre-commit): a Claude Code commit that changes a web app runs
that app's `npm run check` on the staged snapshot. A fake npm records where it ran and what it saw."""

import os
import stat
import subprocess

HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".githooks")


def _repo(tmp_path):
    repo, fakebin, log = tmp_path / "repo", tmp_path / "bin", tmp_path / "npm.log"
    web = repo / "bridge" / "dashboard" / "web"
    (web / "node_modules").mkdir(parents=True)
    (repo / "bridge" / "miniapp" / "web").mkdir(parents=True)
    (web / "x.ts").write_text("good\n")
    (repo / "bridge" / "miniapp" / "web" / "y.ts").write_text("y\n")
    fakebin.mkdir()
    npm = fakebin / "npm"
    npm.write_text('#!/bin/sh\necho "$PWD $(cat x.ts)" >> "$NPM_LOG"\nexit "${FAKE_NPM_RC:-0}"\n')
    npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k != "CLAUDECODE"}
    env.update(PATH=f"{fakebin}{os.pathsep}{env['PATH']}", NPM_LOG=str(log),
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

    def git(*args, **extra):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", f"core.hooksPath={HOOKS}", *args],
                              cwd=repo, env={**env, **extra}, capture_output=True, text=True)

    git("init", "-q")
    git("add", "-A")
    assert git("commit", "-qm", "init").returncode == 0
    return repo, web, git, log


def test_a_claude_commit_checks_the_staged_web_app_only(tmp_path):
    repo, web, git, log = _repo(tmp_path)
    (web / "x.ts").write_text("staged\n")
    git("add", "-A")
    (web / "x.ts").write_text("unstaged\n")    # another session's edit, not in this commit
    r = git("commit", "-qm", "c", CLAUDECODE="1")
    assert r.returncode == 0, r.stdout + r.stderr
    [line] = log.read_text().splitlines()     # once: nothing of the Mini App's is staged
    where, seen = line.rsplit(" ", 1)
    assert where.endswith("/bridge/dashboard/web") and not where.startswith(str(repo))
    assert seen == "staged"


def test_a_failing_check_blocks_only_a_claude_commit_of_web_files(tmp_path):
    repo, web, git, log = _repo(tmp_path)
    (web / "x.ts").write_text("broken\n")
    git("add", "-A")
    r = git("commit", "-qm", "c", CLAUDECODE="1", FAKE_NPM_RC="1")
    assert r.returncode != 0 and "fails npm run check" in r.stdout + r.stderr
    assert git("commit", "-qm", "c", FAKE_NPM_RC="1").returncode == 0   # the bridge's own commit
    (repo / "notes.md").write_text("n\n")
    git("add", "-A")
    assert git("commit", "-qm", "d", CLAUDECODE="1", FAKE_NPM_RC="1").returncode == 0   # no web file
    assert len(log.read_text().splitlines()) == 1
