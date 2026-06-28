"""Unit tests for bridge/github.py slug parsing. Run: python tests/test_github.py"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import github as gh  # noqa: E402


def test_parse_https_git():
    assert gh._parse_slug("https://github.com/owner/repo.git") == "owner/repo"


def test_parse_https_plain():
    assert gh._parse_slug("https://github.com/owner/repo") == "owner/repo"


def test_parse_ssh():
    assert gh._parse_slug("git@github.com:owner/repo.git") == "owner/repo"


def test_parse_trailing_slash():
    assert gh._parse_slug("https://github.com/owner/repo/") == "owner/repo"


def test_parse_uppercase_host():
    assert gh._parse_slug("https://GitHub.com/owner/repo.git") == "owner/repo"


def test_parse_dotted_repo():
    assert gh._parse_slug("https://github.com/owner/repo.io") == "owner/repo.io"


def test_parse_non_github():
    assert gh._parse_slug("https://gitlab.com/owner/repo.git") is None
    assert gh._parse_slug("git@bitbucket.org:owner/repo.git") is None


def test_parse_garbage():
    assert gh._parse_slug("") is None
    assert gh._parse_slug("not a url") is None
    assert gh._parse_slug("https://github.com/owner") is None


def test_remote_slug_from_repo():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    subprocess.run(["git", "-C", d, "remote", "add", "origin",
                    "https://github.com/acme/widget.git"], check=True)
    assert gh.remote_slug(d) == "acme/widget"


def test_remote_slug_none():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    assert gh.remote_slug(d) is None


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
