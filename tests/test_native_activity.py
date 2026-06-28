"""Unit tests for the native live-activity watcher (bridge/native_activity.py).
Env is set before importing the package so config picks up a temp BASE_PATH/DB.
Run: `python tests/test_native_activity.py`
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import machine, native_activity, transcript_jsonl  # noqa: E402


def _append(path, *records):
    with open(path, "a") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def _assistant(text="hi"):
    return {"type": "assistant", "uuid": "a",
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def _tmpfile():
    path = os.path.join(tempfile.mkdtemp(), "sess.jsonl")
    open(path, "w").close()
    return path


def test_first_poll_does_not_replay_history_as_live():
    # A transcript that already has content, last written long ago, should NOT
    # look 'working' the first time the watcher sees it.
    path = _tmpfile()
    _append(path, _assistant("old"))
    os.utime(path, (1000.0, 1000.0))
    tr = native_activity._Tracker("s1", path)
    tr.poll(now=2000.0)
    assert tr.state == "idle"


def test_fresh_append_marks_working():
    path = _tmpfile()
    tr = native_activity._Tracker("s1", path)
    tr.poll(now=100.0)                 # prime at current (empty) end
    _append(path, _assistant("thinking out loud"))
    tr.poll(now=100.5)
    assert tr.state == "working"


def test_goes_idle_after_quiet_window():
    path = _tmpfile()
    tr = native_activity._Tracker("s1", path)
    tr.poll(now=100.0)
    _append(path, _assistant("work"))
    tr.poll(now=100.5)
    assert tr.state == "working"
    tr.poll(now=100.5 + native_activity.WORKING_WINDOW + 1)   # no new writes
    assert tr.state == "idle"


def test_housekeeping_write_does_not_count_as_working():
    path = _tmpfile()
    tr = native_activity._Tracker("s1", path)
    tr.poll(now=100.0)
    _append(path, {"type": "file-history-snapshot", "uuid": "x"})
    tr.poll(now=100.5)
    assert tr.state == "idle"


def test_partial_line_is_not_consumed_until_complete():
    path = _tmpfile()
    tr = native_activity._Tracker("s1", path)
    tr.poll(now=100.0)
    with open(path, "a") as f:             # write a record WITHOUT a trailing newline
        f.write(json.dumps(_assistant("half")))
    tr.poll(now=100.5)
    assert tr.state == "idle"              # incomplete line: don't act on it yet
    with open(path, "a") as f:
        f.write("\n")                      # complete the line
    tr.poll(now=101.0)
    assert tr.state == "working"


def test_seeds_working_from_recent_mtime_on_first_sight():
    # If the watcher first sees a session whose file was written moments ago,
    # it should report 'working' immediately rather than waiting for the next write.
    path = _tmpfile()
    _append(path, _assistant("live"))
    os.utime(path, (5000.0, 5000.0))
    tr = native_activity._Tracker("s1", path)
    tr.poll(now=5000.5)
    assert tr.state == "working"


def test_tick_tracks_alive_sessions_and_prunes_dead(monkeypatched=None):
    path = _tmpfile()
    _append(path, _assistant("x"))
    os.utime(path, (7000.0, 7000.0))

    orig_list = machine.list_running
    orig_find = transcript_jsonl.find_transcript
    machine.list_running = lambda: [{"session_id": "live-1"}]
    transcript_jsonl.find_transcript = lambda sid: path if sid == "live-1" else None
    native_activity._trackers.clear()
    try:
        native_activity._tick(now=7000.5)
        assert "live-1" in native_activity.working_ids()
        snap = native_activity.snapshot()
        assert snap["live-1"]["state"] == "working"
        # session dies -> dropped on next tick
        machine.list_running = lambda: []
        native_activity._tick(now=7002.0)
        assert "live-1" not in native_activity.snapshot()
    finally:
        machine.list_running = orig_list
        transcript_jsonl.find_transcript = orig_find
        native_activity._trackers.clear()


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
