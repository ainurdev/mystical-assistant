"""Unit tests for the ad-hoc remote shell runner (bridge/shell.py).
Run: `python tests/test_shell.py`
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import shell  # noqa: E402

_CWD = tempfile.mkdtemp()


def _wait_done(timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not shell.snapshot()["running"]:
            return
        time.sleep(0.03)


def test_runs_command_and_captures_output():
    assert shell.run(_CWD, "echo hello-shell")["ok"] is True
    _wait_done()
    snap = shell.snapshot()
    assert any("hello-shell" in l["line"] for l in snap["lines"])
    assert snap["status"] == "done" and snap["running"] is False and snap["code"] == 0


def test_empty_command_rejected():
    assert shell.run(_CWD, "   ")["ok"] is False


def test_nonzero_exit_marks_error():
    shell.run(_CWD, "exit 3")
    _wait_done()
    snap = shell.snapshot()
    assert snap["status"] == "error" and snap["code"] == 3


def test_cursor_returns_only_new_lines():
    shell.run(_CWD, "echo first-cmd")
    _wait_done()
    cur = shell.snapshot()["cursor"]
    shell.run(_CWD, "echo second-cmd")
    _wait_done()
    fresh = shell.snapshot(cur)["lines"]
    assert any("second-cmd" in l["line"] for l in fresh)
    assert not any("first-cmd" in l["line"] for l in fresh)


def test_one_command_at_a_time():
    shell.run(_CWD, "sleep 2")
    try:
        assert shell.run(_CWD, "echo blocked")["ok"] is False   # already running
    finally:
        shell.kill()
        _wait_done()


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
