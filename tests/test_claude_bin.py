"""The bridge must resolve the `claude` launcher without trusting the ambient
PATH: it may be started from a context (systemd, cron, a non-login shell, a
nested agent) whose PATH omits ~/.local/bin, where Claude installs its launcher.
Before this fix that raised FileNotFoundError and killed the turn with
"claude not found on PATH". Run: `python tests/test_claude_bin.py`
"""
import os
import stat
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import config, runner  # noqa: E402


def _fake_claude(dirpath):
    p = os.path.join(dirpath, "claude")
    with open(p, "w") as f:
        f.write("#!/bin/sh\necho ok\n")
    os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return p


class _Env:
    """Reset the resolver cache/config/PATH/fallbacks around each test."""
    def __enter__(self):
        self._bin = runner._claude_bin
        self._cfg = config.CLAUDE_BIN
        self._path = os.environ.get("PATH", "")
        self._fb = runner._CLAUDE_FALLBACKS
        runner._claude_bin = None
        config.CLAUDE_BIN = "claude"
        return self

    def __exit__(self, *a):
        runner._claude_bin = self._bin
        config.CLAUDE_BIN = self._cfg
        os.environ["PATH"] = self._path
        runner._CLAUDE_FALLBACKS = self._fb


def test_resolves_via_path_when_present():
    with _Env():
        d = tempfile.mkdtemp()
        fake = _fake_claude(d)
        os.environ["PATH"] = d
        assert runner.claude_bin() == fake


def test_resolves_via_fallback_when_path_stripped():
    # The bug: PATH has no claude, but a known install location does. The turn
    # used to die here with "claude not found on PATH".
    with _Env():
        d = tempfile.mkdtemp()
        fake = _fake_claude(d)
        os.environ["PATH"] = os.path.join(tempfile.mkdtemp(), "empty")
        runner._CLAUDE_FALLBACKS = (fake,)  # stands in for ~/.local/bin/claude
        assert runner.claude_bin() == fake


def test_explicit_override_is_honored():
    with _Env():
        d = tempfile.mkdtemp()
        fake = _fake_claude(d)
        os.environ["PATH"] = os.path.join(tempfile.mkdtemp(), "empty")
        config.CLAUDE_BIN = fake  # absolute-path override wins over PATH/fallbacks
        assert runner.claude_bin() == fake


def test_base_cmd_uses_resolved_bin():
    with _Env():
        d = tempfile.mkdtemp()
        fake = _fake_claude(d)
        config.CLAUDE_BIN = fake
        cmd = runner._base_cmd("hi", 555, stream=False, skip_pack=True)
        assert cmd[0] == fake and cmd[1] == "-p"


def test_unresolvable_falls_back_to_name_for_friendly_error():
    # Nothing on PATH, no fallback present -> return the bare name so the
    # existing FileNotFoundError branch surfaces the friendly message.
    with _Env():
        os.environ["PATH"] = os.path.join(tempfile.mkdtemp(), "empty")
        runner._CLAUDE_FALLBACKS = (os.path.join(tempfile.mkdtemp(), "nope"),)
        assert runner.claude_bin() == "claude"


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
