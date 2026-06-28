"""Unit tests for bridge/git.py against throwaway repos. Run: python tests/test_git.py"""

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
    with open(os.path.join(d, name), "w") as f:
        f.write(text)


def test_not_a_repo():
    assert g.is_repo(tempfile.mkdtemp()) is False
    st = g.status(tempfile.mkdtemp())
    assert st["is_repo"] is False and st["files"] == []


def test_clean_repo():
    d = _mkrepo()
    _write(d, "a.txt", "one\ntwo\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    st = g.status(d)
    assert st["is_repo"] is True
    assert st["dirty"] == 0 and st["files"] == []
    assert st["branch"]  # some branch name


def test_modified_file_counts():
    d = _mkrepo()
    _write(d, "a.txt", "one\ntwo\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "a.txt", "one\ntwo\nthree\n")
    st = g.status(d)
    assert st["dirty"] == 1
    f = st["files"][0]
    assert f["path"] == "a.txt" and f["status"] == "M"
    assert f["add"] == 1 and f["del"] == 0


def test_untracked_file_listed():
    d = _mkrepo()
    _write(d, "a.txt", "x\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "new.txt", "l1\nl2\nl3\n")
    st = g.status(d)
    paths = {f["path"]: f for f in st["files"]}
    assert "new.txt" in paths
    assert paths["new.txt"]["status"] == "?"
    assert paths["new.txt"]["add"] == 3


def test_diff_has_changes():
    d = _mkrepo()
    _write(d, "a.txt", "one\ntwo\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "a.txt", "one\nTWO\n")
    out = g.diff(d, "a.txt")
    assert "-two" in out and "+TWO" in out


def test_commit_clears_dirty():
    d = _mkrepo()
    _write(d, "a.txt", "one\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "a.txt", "one\ntwo\n")
    ok, _out = g.commit(d, "second change")
    assert ok is True
    assert g.status(d)["dirty"] == 0


def test_path_escape_rejected():
    d = _mkrepo()
    assert g._safe_path(d, "../outside") is None
    assert g._safe_path(d, "a.txt") == "a.txt"


def _commit_on_branch(d, branch, start=None):
    if start is None:
        _run(d, "checkout", "-q", "-b", branch)
    else:
        _run(d, "checkout", "-q", "-b", branch, start)


def test_compare_renamed_file_is_diffable():
    """A renamed file must list under its real (new) path so its diff renders —
    not the `old => new` numstat form, which is not a usable pathspec."""
    d = _mkrepo()
    _write(d, "old.txt", "k1\nk2\nk3\nk4\nk5\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "base")
    base = g.current_branch(d)
    _commit_on_branch(d, "feature")
    os.rename(os.path.join(d, "old.txt"), os.path.join(d, "new.txt"))
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "rename")
    cmp = g.compare(d, base, "feature", three_dot=False)
    names = [f["name"] for f in cmp["files"]]
    assert "new.txt" in names, names
    assert not any("=>" in n for n in names), names
    entry = next(f for f in cmp["files"] if f["name"] == "new.txt")
    assert entry["mark"] == "R"
    assert g.diff_ref(d, base, "feature", "new.txt").strip()


def test_compare_unicode_path_is_diffable():
    """A non-ASCII filename must not be C-quoted in the file list, or its per-file
    diff lookup matches nothing and renders blank."""
    d = _mkrepo()
    _write(d, "café.txt", "u\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "base")
    base = g.current_branch(d)
    _commit_on_branch(d, "feature")
    _write(d, "café.txt", "u\nmore\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "edit")
    cmp = g.compare(d, base, "feature", three_dot=False)
    names = [f["name"] for f in cmp["files"]]
    assert "café.txt" in names, names
    assert g.diff_ref(d, base, "feature", "café.txt").strip()


def test_status_unicode_path_is_diffable():
    """A non-ASCII filename in the working tree must list under its real path so
    the working-tree diff renders."""
    d = _mkrepo()
    _write(d, "café.txt", "u\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "café.txt", "u\nmore\n")
    paths = [f["path"] for f in g.status(d)["files"]]
    assert "café.txt" in paths, paths
    assert g.diff(d, "café.txt").strip()


def test_push_to_bare_remote():
    bare = tempfile.mkdtemp()
    subprocess.run(["git", "init", "--bare", "-q", bare], check=True)
    d = _mkrepo()
    _write(d, "a.txt", "one\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    branch = subprocess.run(["git", "-C", d, "branch", "--show-current"],
                            capture_output=True, text=True).stdout.strip()
    _run(d, "remote", "add", "origin", bare)
    _run(d, "push", "-q", "-u", "origin", branch)
    _write(d, "a.txt", "one\ntwo\n")
    g.commit(d, "second")
    ok, _out = g.push(d)
    assert ok is True
    # Verify the remote advanced to our local HEAD (read via ls-remote from the
    # working repo, so we don't touch the bare repo directly — global config may
    # set safe.bareRepository=explicit, which blocks `git -C <bare>`).
    local = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"],
                           capture_output=True, text=True).stdout.strip()
    remote = subprocess.run(["git", "-C", d, "ls-remote", "origin", branch],
                            capture_output=True, text=True).stdout.split("\t")[0].strip()
    assert local and local == remote


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
