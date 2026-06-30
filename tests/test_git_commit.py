"""git.py commit helpers: per-file (partial) commit, multi-path diff for commit
message generation, and commit-message cleanup. Run: `python tests/test_git_commit.py`
(or pytest). Uses a real throwaway repo per test — git is stdlib-only here."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")

from bridge import git  # noqa: E402


def _init_repo(d: str) -> None:
    git._run(d, "init")
    git._run(d, "config", "user.email", "t@t.t")
    git._run(d, "config", "user.name", "t")
    git._run(d, "config", "commit.gpgsign", "false")
    with open(os.path.join(d, "a.txt"), "w") as f:
        f.write("a0\n")
    with open(os.path.join(d, "b.txt"), "w") as f:
        f.write("b0\n")
    git._run(d, "add", "-A")
    git._run(d, "commit", "-m", "init")


def _dirty(d: str) -> set:
    return {f["path"] for f in git.status(d)["files"]}


def test_commit_paths_commits_only_selected(tmp_path):
    d = str(tmp_path)
    _init_repo(d)
    (tmp_path / "a.txt").write_text("a1\n")
    (tmp_path / "b.txt").write_text("b1\n")
    ok, _out = git.commit_paths(d, "touch a", ["a.txt"])
    assert ok
    assert _dirty(d) == {"b.txt"}                     # b is left uncommitted
    _rc, out, _ = git._run(d, "show", "HEAD:a.txt")   # a's new content is committed
    assert out == "a1\n"


def test_commit_paths_includes_untracked_selected(tmp_path):
    d = str(tmp_path)
    _init_repo(d)
    (tmp_path / "c.txt").write_text("c0\n")            # new, untracked
    (tmp_path / "a.txt").write_text("a1\n")            # modified, NOT selected
    ok, _out = git.commit_paths(d, "add c", ["c.txt"])
    assert ok
    _rc, out, _ = git._run(d, "ls-files", "c.txt")
    assert "c.txt" in out                             # now tracked
    assert _dirty(d) == {"a.txt"}                     # a still dirty


def test_commit_paths_ignores_other_staged_files(tmp_path):
    d = str(tmp_path)
    _init_repo(d)
    (tmp_path / "a.txt").write_text("a1\n")
    (tmp_path / "b.txt").write_text("b1\n")
    git._run(d, "add", "b.txt")                        # b staged but NOT selected
    ok, _out = git.commit_paths(d, "only a", ["a.txt"])
    assert ok
    assert "b.txt" in _dirty(d)                        # b stays out of the commit


def test_commit_paths_rejects_empty_selection(tmp_path):
    d = str(tmp_path)
    _init_repo(d)
    ok, _out = git.commit_paths(d, "noop", [])
    assert not ok


def test_diff_multi_concatenates_selected_paths(tmp_path):
    d = str(tmp_path)
    _init_repo(d)
    (tmp_path / "a.txt").write_text("a1\n")
    (tmp_path / "b.txt").write_text("b1\n")
    out = git.diff_multi(d, ["a.txt", "b.txt"])
    assert "a.txt" in out and "b.txt" in out
    assert "a1" in out and "b1" in out
    only_a = git.diff_multi(d, ["a.txt"])             # unselected file excluded
    assert "b.txt" not in only_a


def test_diff_multi_includes_untracked(tmp_path):
    d = str(tmp_path)
    _init_repo(d)
    (tmp_path / "c.txt").write_text("hello new file\n")
    out = git.diff_multi(d, ["c.txt"])
    assert "hello new file" in out


def test_diff_multi_respects_limit(tmp_path):
    d = str(tmp_path)
    _init_repo(d)
    (tmp_path / "a.txt").write_text("x\n" * 5000)
    out = git.diff_multi(d, ["a.txt"], limit=500)
    assert len(out) <= 500


def test_clean_commit_message_strips_code_fence():
    assert git.clean_commit_message("```\nfeat: add thing\n```") == "feat: add thing"


def test_clean_commit_message_strips_fence_with_lang_and_keeps_body():
    raw = "```text\nfix: bug\n\nbody line\n```"
    assert git.clean_commit_message(raw) == "fix: bug\n\nbody line"


def test_clean_commit_message_strips_wrapping_quotes():
    assert git.clean_commit_message('"feat: quoted"') == "feat: quoted"


def test_clean_commit_message_leaves_plain_message():
    assert git.clean_commit_message("  chore: tidy  ") == "chore: tidy"


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
