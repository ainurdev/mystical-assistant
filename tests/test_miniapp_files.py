"""The Mini App's file endpoints (/api/files, /api/files/read,
/api/files/write). Driven without sockets via Handler.__new__, mirroring
test_fallback_endpoints.py. Run: python tests/test_miniapp_files.py
"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import git, state  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402

CHAT = 555


def _handler():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _mkrepo():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    with open(os.path.join(d, "hello.py"), "w") as f:
        f.write("print('hi')\n")
    return d


def _use(repo):
    """Point the chat's project at `repo` for the duration of a test."""
    saved = state.project_dir
    state.project_dir = lambda chat_id: repo
    mini.state.project_dir = state.project_dir
    return lambda: (setattr(state, "project_dir", saved),
                    setattr(mini.state, "project_dir", saved))


def test_read_returns_file_contents():
    repo = _mkrepo()
    restore = _use(repo)
    h, box = _handler()
    try:
        h._json(git.read_file(state.project_dir(CHAT), "hello.py"))
        assert box["obj"]["ok"] is True
        assert box["obj"]["content"] == "print('hi')\n"
    finally:
        restore()


def test_write_saves_to_disk():
    repo = _mkrepo()
    restore = _use(repo)
    h, box = _handler()
    try:
        h._api_file_write(CHAT, {"path": "hello.py", "content": "print('bye')\n"})
        assert box["code"] == 200 and box["obj"]["ok"] is True
        with open(os.path.join(repo, "hello.py")) as f:
            assert f.read() == "print('bye')\n"
    finally:
        restore()


def test_write_creates_parent_directories():
    repo = _mkrepo()
    restore = _use(repo)
    h, box = _handler()
    try:
        h._api_file_write(CHAT, {"path": "a/b/new.txt", "content": "x"})
        assert box["code"] == 200
        assert os.path.isfile(os.path.join(repo, "a/b/new.txt"))
    finally:
        restore()


def test_write_refuses_to_escape_the_project():
    repo = _mkrepo()
    outside = os.path.join(os.path.dirname(repo), "escaped.txt")
    restore = _use(repo)
    h, box = _handler()
    try:
        h._api_file_write(CHAT, {"path": "../escaped.txt", "content": "pwned"})
        assert box["code"] == 400
        assert not os.path.exists(outside)
    finally:
        restore()


def test_write_refuses_to_touch_dot_git():
    repo = _mkrepo()
    restore = _use(repo)
    h, box = _handler()
    try:
        h._api_file_write(CHAT, {"path": ".git/config", "content": "broken"})
        assert box["code"] == 400
    finally:
        restore()


def test_write_rejects_a_non_string_body():
    repo = _mkrepo()
    restore = _use(repo)
    h, box = _handler()
    try:
        h._api_file_write(CHAT, {"path": "hello.py", "content": None})
        assert box["code"] == 400
        with open(os.path.join(repo, "hello.py")) as f:
            assert f.read() == "print('hi')\n"   # untouched
    finally:
        restore()


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok - {fn.__name__}")
    print(f"\n{len(fns)} passed")
