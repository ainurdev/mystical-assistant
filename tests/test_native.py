"""Unit tests for the native-session discovery scanner (bridge/native.py).
Env is set before importing the package so config picks up a temp BASE_PATH/DB.
Run: `python tests/test_native.py`
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_BASE = tempfile.mkdtemp()
os.environ["BASE_PATH"] = _BASE                       # override any shell leak
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config, store, native, transcript_jsonl   # noqa: E402

store.init()
transcript_jsonl.PROJECTS_DIR = tempfile.mkdtemp()    # fake ~/.claude/projects

OWNER = 555


def _write_native(uuid, cwd, first_user="hello scan", with_cwd=True, dirname=None):
    root = transcript_jsonl.PROJECTS_DIR
    pdir = os.path.join(root, dirname or ("p-" + uuid))
    os.makedirs(pdir, exist_ok=True)
    recs = [{"type": "queue-operation", "sessionId": uuid, "operation": "x"}]
    user = {"type": "user", "sessionId": uuid, "uuid": uuid + "-u",
            "message": {"role": "user", "content": first_user}}
    if with_cwd:
        user["cwd"] = cwd
    recs.append(user)
    recs.append({"type": "assistant", "sessionId": uuid, "uuid": uuid + "-a",
                 "message": {"role": "assistant", "content": [
                     {"type": "text", "text": "ok"}]}})
    path = os.path.join(pdir, uuid + ".jsonl")
    with open(path, "w") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
    return path


def test_scan_indexes_session_under_base():
    cwd = os.path.join(_BASE, "repo")
    os.makedirs(cwd, exist_ok=True)
    _write_native("uuid-in-base", cwd, first_user="build the thing")
    native.scan(chat_id=OWNER)
    row = store.get_by_claude_session_id("uuid-in-base")
    assert row is not None
    assert row["origin"] == "vscode"
    assert row["claude_session_id"] == "uuid-in-base" and row["id"] == "uuid-in-base"
    assert row["project"] == "/repo" and row["cwd"] == cwd
    assert row["title"] == "build the thing"


def test_scan_skips_session_outside_base():
    outside = tempfile.mkdtemp()                      # not under _BASE
    _write_native("uuid-outside", os.path.join(outside, "x"))
    native.scan(chat_id=OWNER)
    assert store.get_by_claude_session_id("uuid-outside") is None


def test_scan_skips_transcript_without_recoverable_cwd():
    _write_native("uuid-nocwd", os.path.join(_BASE, "y"), with_cwd=False)
    native.scan(chat_id=OWNER)
    assert store.get_by_claude_session_id("uuid-nocwd") is None


def test_scan_skips_internal_oneshot():
    # Commit-message / preview one-shots persist a JSONL but must stay off the list.
    cwd = os.path.join(_BASE, "oneshot")
    first = native.INTERNAL_ONESHOT_TAG + "\nWrite a single git commit message..."
    _write_native("uuid-oneshot", cwd, first_user=first)
    native.scan(chat_id=OWNER)
    assert store.get_by_claude_session_id("uuid-oneshot") is None


def test_scan_skips_legacy_untagged_oneshot():
    # Pre-tag one-shots persist untagged on disk; scan must still skip them by
    # prompt signature so cleaned-up rows don't resurface on the next rescan.
    cwd = os.path.join(_BASE, "legacy")
    first = "You are configuring a one-click 'preview' button for this project."
    _write_native("uuid-legacy", cwd, first_user=first)
    native.scan(chat_id=OWNER)
    assert store.get_by_claude_session_id("uuid-legacy") is None


def test_scan_is_idempotent():
    cwd = os.path.join(_BASE, "idem")
    _write_native("uuid-idem", cwd)
    native.scan(chat_id=OWNER)
    native.scan(chat_id=OWNER)
    rows = [r for r in store.list_sessions_all(OWNER)
            if r["claude_session_id"] == "uuid-idem"]
    assert len(rows) == 1


def test_scan_returns_count_of_indexed():
    n = native.scan(chat_id=OWNER)
    assert isinstance(n, int) and n >= 1


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
