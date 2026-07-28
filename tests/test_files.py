"""Unit tests for bridge/git.py editor helpers — list_tree / read_file /
write_file — against throwaway repos. Run: python tests/test_files.py"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import git as g  # noqa: E402


def _run(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mkrepo():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    _run(d, "config", "user.email", "t@example.com")
    _run(d, "config", "user.name", "Tester")
    _run(d, "config", "commit.gpgsign", "false")
    return d


def _write(d, name, text):
    path = os.path.join(d, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def test_list_tree_tracked_untracked_and_ignored():
    d = _mkrepo()
    _write(d, "a.txt", "one\n")
    _write(d, "src/b.ts", "x\n")
    _write(d, ".gitignore", "ignored/\n*.log\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "new.py", "n\n")          # untracked, not ignored
    _write(d, "debug.log", "l\n")       # ignored by pattern
    _write(d, "ignored/x.txt", "z\n")   # ignored by directory
    tree = g.list_tree(d)
    assert "a.txt" in tree, tree
    assert "src/b.ts" in tree, tree
    assert "new.py" in tree, tree       # untracked-but-not-ignored is editable
    assert ".gitignore" in tree, tree
    assert "debug.log" not in tree, tree
    assert "ignored/x.txt" not in tree, tree
    assert tree == sorted(tree), tree   # stable, sorted


def test_list_tree_non_repo():
    assert g.list_tree(tempfile.mkdtemp()) == []


def test_list_tree_dedupes():
    d = _mkrepo()
    _write(d, "a.txt", "one\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    tree = g.list_tree(d)
    assert tree.count("a.txt") == 1, tree


def test_read_file_text():
    d = _mkrepo()
    _write(d, "a.txt", "hello\nworld\n")
    r = g.read_file(d, "a.txt")
    assert r["ok"] is True
    assert r["content"] == "hello\nworld\n"
    assert r["binary"] is False and r["too_large"] is False


def test_read_file_escape_rejected():
    d = _mkrepo()
    r = g.read_file(d, "../etc/passwd")
    assert r["ok"] is False


def test_read_file_missing():
    d = _mkrepo()
    r = g.read_file(d, "nope.txt")
    assert r["ok"] is False


def test_read_file_binary_flagged():
    d = _mkrepo()
    with open(os.path.join(d, "b.bin"), "wb") as f:
        f.write(b"\x00\x01\x02BINARY")
    r = g.read_file(d, "b.bin")
    assert r["ok"] is True and r["binary"] is True and r["content"] == ""


def test_read_file_too_large_flagged():
    d = _mkrepo()
    with open(os.path.join(d, "big.txt"), "w") as f:
        f.write("x" * (g._MAX_FILE + 10))
    r = g.read_file(d, "big.txt")
    assert r["ok"] is True and r["too_large"] is True and r["content"] == ""


def test_write_file_roundtrip():
    d = _mkrepo()
    _write(d, "a.txt", "old\n")
    ok, _ = g.write_file(d, "a.txt", "new content\n")
    assert ok is True
    with open(os.path.join(d, "a.txt")) as f:
        assert f.read() == "new content\n"


def test_write_file_creates_parents():
    d = _mkrepo()
    ok, _ = g.write_file(d, "sub/deep/x.txt", "hi\n")
    assert ok is True
    assert os.path.isfile(os.path.join(d, "sub/deep/x.txt"))


def test_write_file_escape_rejected():
    d = _mkrepo()
    outside = os.path.join(os.path.dirname(d), "evil.txt")
    if os.path.exists(outside):
        os.remove(outside)
    ok, _ = g.write_file(d, "../evil.txt", "x")
    assert ok is False
    assert not os.path.exists(outside)


def test_write_preserves_lf():
    d = _mkrepo()
    ok, _ = g.write_file(d, "a.txt", "a\nb\nc\n")
    assert ok is True
    with open(os.path.join(d, "a.txt"), "rb") as f:
        assert f.read() == b"a\nb\nc\n"     # no CRLF translation on write


def test_read_after_write_roundtrips_unicode():
    d = _mkrepo()
    ok, _ = g.write_file(d, "u.txt", "café ☕\n")
    assert ok is True
    r = g.read_file(d, "u.txt")
    assert r["ok"] is True and r["content"] == "café ☕\n"


def test_grep_finds_tracked_and_untracked():
    d = _mkrepo()
    _write(d, "a.py", "def hello():\n    pass\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "b.ts", "export function Hello() {}\n")   # untracked
    _write(d, ".gitignore", "skip/\n")
    _write(d, "skip/c.ts", "hello there\n")             # ignored
    hits = g.grep(d, "hello")                            # case-insensitive
    paths = {h["path"] for h in hits}
    assert "a.py" in paths and "b.ts" in paths, hits
    assert "skip/c.ts" not in paths, hits
    assert [h for h in hits if h["path"] == "a.py"][0]["line"] == 1, hits


def test_grep_empty_and_no_match():
    d = _mkrepo()
    _write(d, "a.txt", "one\n")
    assert g.grep(d, "") == []
    assert g.grep(d, "nothing-here") == []
    assert g.grep(tempfile.mkdtemp(), "x") == []        # not a repo


def test_create_file_and_dir():
    d = _mkrepo()
    ok, _ = g.create_path(d, "src/new.ts")
    assert ok is True and os.path.isfile(os.path.join(d, "src/new.ts"))
    ok, _ = g.create_path(d, "src/sub", directory=True)
    assert ok is True and os.path.isdir(os.path.join(d, "src/sub"))
    ok, err = g.create_path(d, "src/new.ts")            # no clobbering
    assert ok is False and err == "already exists"


def test_rename_and_delete():
    d = _mkrepo()
    _write(d, "src/a.txt", "hi\n")
    ok, _ = g.rename_path(d, "src/a.txt", "src/deep/b.txt")
    assert ok is True
    assert os.path.isfile(os.path.join(d, "src/deep/b.txt"))
    assert not os.path.exists(os.path.join(d, "src/a.txt"))
    ok, _ = g.delete_path(d, "src")                     # directory + contents
    assert ok is True and not os.path.exists(os.path.join(d, "src"))


def test_mutating_ops_refuse_git_dir_and_root():
    d = _mkrepo()
    assert g.delete_path(d, ".git")[0] is False
    assert g.delete_path(d, ".")[0] is False
    assert g.write_file(d, ".git/config", "boom")[0] is False
    assert g.rename_path(d, ".git", "gone")[0] is False
    assert g.create_path(d, "../escape.txt")[0] is False
    assert os.path.isdir(os.path.join(d, ".git"))


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
