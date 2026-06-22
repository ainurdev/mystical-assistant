"""Unit tests for the trickiest backend logic: Mini App initData auth and the
Claude stream-json event parsing. Run directly: `python tests/test_bridge.py`
(or with pytest). Env is set before importing the package so config picks it up.
"""

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")

from bridge import config, runner                       # noqa: E402
from bridge.miniapp.server import validate_init_data     # noqa: E402


def make_init_data(token, user_id, auth_date=None, tamper=False):
    auth_date = auth_date if auth_date is not None else int(time.time())
    user = json.dumps({"id": user_id, "first_name": "T"}, separators=(",", ":"))
    params = {"auth_date": str(auth_date), "query_id": "abc", "user": user}
    check = "\n".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    h = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if tamper:
        h = "0" * len(h)
    parts = {**params, "hash": h}
    return "&".join(f"{k}={urllib.parse.quote(v, safe='')}" for k, v in parts.items())


# --- initData auth ----------------------------------------------------------

def test_valid_init_data():
    assert validate_init_data(make_init_data(config.TOKEN, 555)) == 555


def test_tampered_hash_rejected():
    assert validate_init_data(make_init_data(config.TOKEN, 555, tamper=True)) is None


def test_wrong_token_rejected():
    assert validate_init_data(make_init_data("99999:WRONG", 555)) is None


def test_disallowed_user_rejected():
    assert validate_init_data(make_init_data(config.TOKEN, 999)) is None


def test_stale_auth_date_rejected():
    old = int(time.time()) - 200000
    assert validate_init_data(make_init_data(config.TOKEN, 555, auth_date=old)) is None


def test_empty_init_data_rejected():
    assert validate_init_data("") is None


# --- stream-json parsing ----------------------------------------------------

def test_stream_event_parsing():
    job = runner.Job("j1", 555)
    runner._handle_event(job, {"type": "system", "subtype": "init", "session_id": "sess-1"})
    runner._handle_event(job, {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "working"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "ls -la"}},
    ]}})
    runner._handle_event(job, {"type": "user", "message": {"content": [
        {"type": "tool_result", "content": "ok"},
    ]}})
    runner._handle_event(job, {"type": "result", "result": "done",
                               "total_cost_usd": 0.0123, "is_error": False,
                               "session_id": "sess-1"})
    types = [e["type"] for e in job.events]
    assert types == ["text", "tool", "tool_done", "result"], types
    assert job.session_id == "sess-1"
    assert job.status == "done"
    assert job.result == "done"
    assert job.cost == 0.0123
    assert any(e.get("summary") == "ls -la" for e in job.events)


def test_result_is_error_sets_error_status():
    job = runner.Job("j2", 555)
    runner._handle_event(job, {"type": "result", "result": "boom", "is_error": True})
    assert job.status == "error"


def test_summarize_tool():
    assert runner._summarize_tool("Bash", {"command": "npm test"}) == "npm test"
    assert runner._summarize_tool("Edit", {"file_path": "a.ts"}) == "a.ts"
    assert runner._summarize_tool("Read", {"file_path": "/x/y.py"}) == "/x/y.py"
    assert runner._summarize_tool("Weird", {}) == ""


def test_job_snapshot_cursor():
    job = runner.Job("j3", 555)
    job.add({"type": "text", "text": "a"})
    job.add({"type": "text", "text": "b"})
    snap = job.snapshot(1)
    assert snap["events"] == [{"type": "text", "text": "b"}]
    assert snap["next_cursor"] == 2
    assert snap["status"] == "running"
    assert "result" not in snap


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
