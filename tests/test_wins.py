"""Today's wins (bridge/wins.py): which Bash calls count as something shipped,
and how a day folds into wins, stretches worked and gaps away.
Run: python -m pytest tests/test_wins.py -v"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, store, wins  # noqa: E402

C = wins.classify


def kinds(cmd, out="", err=False):
    return [(w["kind"], w["text"]) for w in C(cmd, out, err)]


def test_a_commit_counts_with_its_subject():
    assert kinds('git commit -m "runner: close stdin"', "[master 1a2b3c4] runner: close stdin\n 1 file changed") == \
        [("commit", "runner: close stdin")]
    assert kinds('git add -A && git commit -q -m "paths: flow state"') == [("commit", "paths: flow state")]
    assert kinds("git commit -m \"$(cat <<'EOF'\nsettings: five tabs\n\nbody\nEOF\n)\"") == [("commit", "settings: five tabs")]


def test_a_commit_that_did_not_land_is_no_win():
    assert kinds('git commit -m "x"', "nothing to commit, working tree clean") == []
    assert kinds('git commit -m "x"', "pre-commit hook failed", err=True) == []
    assert kinds('git commit --amend --no-edit', "[master 1a2b3c4] x") == []


def test_merges_count_only_when_they_merged():
    assert kinds("git merge --ff-only feat/x", "Updating a..b\nFast-forward\n") == [("merge", "feat/x")]
    assert kinds('git merge --no-ff -m "Merge x" feat/y', "Merge made by the 'ort' strategy.") == [("merge", "feat/y")]
    assert kinds("git merge feat/x", "CONFLICT (content): Merge conflict in a.py", err=True) == []
    assert kinds("git merge feat/x", "Already up to date.") == []
    assert kinds("git merge --abort") == []
    assert kinds("git merge-base master feat/x", "abc123") == []


def test_pushes_and_prs():
    assert kinds("git push origin feat/x", "To github.com:a/b.git\n   1a..2b  feat/x -> feat/x") == [("push", "feat/x")]
    assert kinds("git push", "Everything up-to-date") == []
    assert kinds("git push origin master", " ! [rejected]        master -> master (fetch first)", err=True) == []
    assert kinds('gh pr create --title "x" --body "y"', "https://github.com/a/b/pull/112\n") == [("pr", "#112")]
    assert kinds('gh pr create --title "x"', "pull request create failed", err=True) == []


def test_test_runs_count_only_when_all_passed():
    assert kinds("python3 -m pytest tests/ -q", "....\n3564 passed in 19.20s") == [("tests", "3,564")]
    assert kinds("python3 -m pytest tests/ -q", "1 failed, 83 passed in 2.08s") == []
    assert kinds("npx vitest run", " Tests  42 passed (42)") == [("tests", "42")]
    assert kinds("node --test src/lib", "# pass 12\n# fail 0") == [("tests", "12")]
    assert kinds("python3 -m pytest", "3 passed", err=True) == []


def test_a_mention_is_not_a_command():
    # A report written through a heredoc, a script that prints git words, a grep.
    assert kinds("cat >> report.md <<'EOF'\nthen git merge feat/x and git push\nEOF", "") == []
    assert kinds("python3 - <<'EOF'\nprint('git commit -m x')\nEOF", "[master 1a2b3c4] x") == []
    assert kinds('echo "git push origin master"', "git push origin master") == []
    assert kinds("grep -n 'git merge' notes.md", "3: git merge feat/x") == []


def test_one_call_can_show_two_wins():
    out = "[feat/x 1a2b3c4] wip\n 1 file changed\nTo github.com:a/b.git\n   1a..2b  feat/x -> feat/x"
    assert kinds('git commit -m "wip" && git push origin feat/x', out) == [("commit", "wip"), ("push", "feat/x")]


def test_today_folds_a_turns_commits_and_test_runs():
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "/proj-wins")["id"]
    now = time.time()
    ids = iter(range(100))

    def bash(tid, cmd, out, err=False):
        i = f"toolu_{next(ids)}"
        store.append_event(sid, tid, {"type": "tool", "name": "Bash", "id": i, "summary": cmd, "detail": cmd})
        store.append_event(sid, tid, {"type": "tool_done", "id": i, "output": out, "is_error": err, "ms": 5})

    store.start_turn(sid, f"{sid}:1", "build it", None)
    bash(f"{sid}:1", 'git commit -m "one"', "[m 1a2b3c4] one")
    bash(f"{sid}:1", 'git commit -m "two"', "[m 2b3c4d5] two")
    bash(f"{sid}:1", "python3 -m pytest -q", "1 failed, 9 passed")
    bash(f"{sid}:1", "python3 -m pytest -q", "10 passed in 1s")
    bash(f"{sid}:1", "git merge --ff-only feat/x", "Fast-forward")
    store.finish_turn(f"{sid}:1", "done", None, 30)

    r = wins.today(config.DASH_CHAT_ID, now=now + 60)
    mine = [w for w in r["wins"] if w["session"] == sid]
    by = {w["kind"]: w for w in mine}
    assert set(by) == {"commits", "tests", "merge"}
    assert by["commits"]["text"] == "2" and by["commits"]["detail"] == "two" and by["commits"]["big"]
    assert by["tests"]["text"] == "10" and not by["tests"]["big"]
    assert by["merge"]["text"] == "feat/x" and by["merge"]["project"] == "/proj-wins"
    assert [w["ts"] for w in r["wins"]] == sorted((w["ts"] for w in r["wins"]), reverse=True)
    assert any(s["project"] == "/proj-wins" for s in r["work"])
    assert r["worked"] >= 0 and isinstance(r["away"], list)


def test_away_is_a_gap_of_half_an_hour_or_more():
    u = wins._union([(0, 100), (200, 300), (300 + wins.AWAY + 10, 400 + wins.AWAY)])
    assert u == [[0, 300], [300 + wins.AWAY + 10, 400 + wins.AWAY]]
