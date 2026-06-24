"""Unit tests for the per-session run registry (bridge/state.py).

Concurrent turns on the SAME Claude session would corrupt its transcript (two
--resume on one session), so a session may hold only one in-flight turn; but
different sessions run concurrently so one surface never blocks another.
Run: `python tests/test_run_locks.py`
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import state  # noqa: E402


def _reset():
    for sid in list(state.running_chats() and state._run_chats.keys()):
        state.release_run(sid)


def test_same_session_cannot_run_twice():
    _reset()
    assert state.acquire_run("s1", 555) is True
    assert state.acquire_run("s1", 555) is False     # already in-flight
    state.release_run("s1")


def test_different_sessions_run_concurrently():
    _reset()
    assert state.acquire_run("a", 555) is True
    assert state.acquire_run("b", 555) is True       # different session, no contention
    assert state.is_running("a") and state.is_running("b")
    assert state.running_chats() == {555}
    state.release_run("a")
    state.release_run("b")


def test_release_frees_the_slot():
    _reset()
    state.acquire_run("s1", 555)
    state.release_run("s1")
    assert state.is_running("s1") is False
    assert state.acquire_run("s1", 555) is True      # reusable after release
    state.release_run("s1")


def test_release_of_unheld_session_is_safe():
    _reset()
    state.release_run("never-acquired")              # must not raise
    assert state.is_running("never-acquired") is False


def test_any_running_reflects_state():
    _reset()
    assert state.any_running() is False
    state.acquire_run("s1", 555)
    assert state.any_running() is True
    state.release_run("s1")
    assert state.any_running() is False


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
