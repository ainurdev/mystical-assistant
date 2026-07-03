"""Integration test: the dashboard file endpoints wire _worktree_cwd + the
git helpers together correctly. Builds a Handler without a socket and drives
_get_api/_post_api directly (mirrors test_bridge.py's Handler.__new__ trick).
Run: python tests/test_files_endpoints.py"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import config  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

BASE = config.BASE_PATH


def _git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mkproject(name):
    d = os.path.join(BASE, name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    _git(d, "config", "user.email", "t@example.com")
    _git(d, "config", "user.name", "Tester")
    with open(os.path.join(d, "a.txt"), "w") as f:
        f.write("hello\n")
    _git(d, "add", "-A")
    _git(d, "commit", "-qm", "init")
    return name, d


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_tree_endpoint_lists_files():
    name, _ = _mkproject("proj_tree")
    h, box = _handler()
    h._get_api("/local/files/tree", {"project": [name], "branch": [""]})
    assert box["code"] == 200
    assert "a.txt" in box["obj"]["files"]


def test_read_endpoint_returns_content():
    name, _ = _mkproject("proj_read")
    h, box = _handler()
    h._get_api("/local/files/read", {"project": [name], "path": ["a.txt"], "branch": [""]})
    assert box["obj"]["ok"] is True
    assert box["obj"]["content"] == "hello\n"


def test_read_endpoint_rejects_escape():
    name, _ = _mkproject("proj_read_escape")
    h, box = _handler()
    h._get_api("/local/files/read",
               {"project": [name], "path": ["../../etc/passwd"], "branch": [""]})
    assert box["obj"]["ok"] is False


def test_write_endpoint_saves_to_disk():
    name, d = _mkproject("proj_write")
    h, box = _handler()
    h._post_api("/local/files/write",
                {"project": name, "path": "a.txt", "content": "changed\n"})
    assert box["obj"]["ok"] is True
    with open(os.path.join(d, "a.txt")) as f:
        assert f.read() == "changed\n"


def test_write_endpoint_rejects_escape():
    name, _ = _mkproject("proj_write_escape")
    outside = os.path.join(BASE, "escaped.txt")
    if os.path.exists(outside):
        os.remove(outside)
    h, box = _handler()
    h._post_api("/local/files/write",
                {"project": name, "path": "../escaped.txt", "content": "x"})
    assert box["obj"]["ok"] is False
    assert not os.path.exists(outside)


def test_write_endpoint_rejects_non_string_content():
    name, _ = _mkproject("proj_write_type")
    h, box = _handler()
    h._post_api("/local/files/write", {"project": name, "path": "a.txt", "content": 123})
    assert box["code"] == 400


def test_tree_endpoint_invalid_project():
    h, box = _handler()
    h._get_api("/local/files/tree", {"project": ["does_not_exist_xyz"], "branch": [""]})
    assert box["code"] == 400


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
