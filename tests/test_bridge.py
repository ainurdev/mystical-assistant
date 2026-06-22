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
from bridge.miniapp.server import (                       # noqa: E402
    validate_init_data, normalize_model_effort)


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
    assert snap["pending"] == []
    assert "result" not in snap


# --- interactive control protocol (permissions + questions) -----------------

class _FakeStdin:
    def __init__(self):
        self.data: list[str] = []
        self.closed = False

    def write(self, s):
        self.data.append(s)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class _FakeProc:
    def __init__(self):
        self.stdin = _FakeStdin()
        self.terminated = False
        self.killed = False
        self._returncode = None

    def poll(self):
        return self._returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True
        self._returncode = -9


def _last_sent(job):
    return json.loads(job.proc.stdin.data[-1])


def test_permission_request_and_allow():
    job = runner.Job("p1", 555)
    job.proc = _FakeProc()
    runner._handle_control_request(job, {
        "type": "control_request", "request_id": "r1",
        "request": {"subtype": "can_use_tool", "tool_name": "Write",
                    "input": {"file_path": "a.ts", "content": "x"}}})
    assert len(job.pending) == 1 and job.pending[0]["kind"] == "permission"
    ev = [e for e in job.events if e["type"] == "permission"][0]
    assert ev["request_id"] == "r1" and ev["tool_name"] == "Write"

    assert job.respond("r1", behavior="allow") is True
    assert job.pending == []
    sent = _last_sent(job)
    assert sent["type"] == "control_response"
    assert sent["response"]["request_id"] == "r1"
    assert sent["response"]["response"] == {
        "behavior": "allow", "updatedInput": {"file_path": "a.ts", "content": "x"}}
    assert any(e["type"] == "permission_resolved" and e["behavior"] == "allow"
               for e in job.events)


def test_permission_deny():
    job = runner.Job("p2", 555)
    job.proc = _FakeProc()
    runner._handle_control_request(job, {
        "request_id": "r", "request": {"subtype": "can_use_tool", "tool_name": "Bash",
                                        "input": {"command": "rm -rf /"}}})
    assert job.respond("r", behavior="deny") is True
    resp = _last_sent(job)["response"]["response"]
    assert resp["behavior"] == "deny" and resp["message"]


def test_question_request_and_answer():
    job = runner.Job("q1", 555)
    job.proc = _FakeProc()
    runner._handle_control_request(job, {
        "request_id": "r2", "request": {
            "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
            "input": {"questions": [{
                "question": "Fav color?", "header": "Color", "multiSelect": False,
                "options": [{"label": "Red", "description": ""},
                            {"label": "Blue", "description": ""}]}]}}})
    assert job.pending[0]["kind"] == "question"
    qev = [e for e in job.events if e["type"] == "question"][0]
    assert qev["questions"][0]["header"] == "Color"

    assert job.respond("r2", answers=[{"header": "Color", "labels": ["Blue"]}]) is True
    resp = _last_sent(job)["response"]["response"]
    assert resp["behavior"] == "deny" and "Blue" in resp["message"]
    assert any(e["type"] == "question_answered" for e in job.events)


def test_respond_unknown_request_returns_false():
    job = runner.Job("u1", 555)
    job.proc = _FakeProc()
    assert job.respond("nope", behavior="allow") is False


def test_snapshot_includes_pending():
    job = runner.Job("s1", 555)
    job.proc = _FakeProc()
    runner._handle_control_request(job, {
        "request_id": "r", "request": {"subtype": "can_use_tool", "tool_name": "Edit",
                                        "input": {"file_path": "x"}}})
    snap = job.snapshot(0)
    assert len(snap["pending"]) == 1 and snap["pending"][0]["request_id"] == "r"


def test_format_answers_multiselect():
    msg = runner._format_answers(
        [{"header": "Features", "question": "Which?"}],
        [{"header": "Features", "labels": ["Auth", "Billing"]}])
    assert "Features" in msg and "Auth, Billing" in msg


def test_interactive_base_cmd():
    cmd = runner._base_cmd("hello-prompt", 555, stream=True, interactive=True)
    assert "--input-format" in cmd and "stream-json" in cmd
    assert "--permission-prompt-tool" in cmd and "stdio" in cmd
    assert "--permission-mode" in cmd
    assert "hello-prompt" not in cmd          # prompt goes via stdin, not argv
    assert "acceptEdits" not in cmd            # EXTRA_CLAUDE_ARGS skipped


def test_blocking_base_cmd_unchanged():
    cmd = runner._base_cmd("hi", 555, stream=False)
    assert cmd[:3] == ["claude", "-p", "hi"]
    assert "--input-format" not in cmd
    assert "--permission-prompt-tool" not in cmd


# --- model / effort flags ---------------------------------------------------

def test_base_cmd_model_and_effort():
    cmd = runner._base_cmd("p", 555, stream=True, interactive=True,
                           model="opus", effort="high")
    assert cmd[cmd.index("--model") + 1] == "opus"
    assert cmd[cmd.index("--effort") + 1] == "high"


def test_base_cmd_omits_model_effort_by_default():
    cmd = runner._base_cmd("p", 555, stream=True, interactive=True)
    assert "--model" not in cmd
    assert "--effort" not in cmd


# --- interrupt --------------------------------------------------------------

def test_interrupt_writes_control_request_and_marks_job():
    job = runner.Job("i1", 555)
    job.proc = _FakeProc()
    assert job.interrupt() is True
    assert job.interrupted is True
    if job._interrupt_timer:
        job._interrupt_timer.cancel()
    sent = _last_sent(job)
    assert sent["type"] == "control_request"
    assert sent["request"]["subtype"] == "interrupt"


def test_interrupt_not_running_returns_false():
    job = runner.Job("i2", 555)
    job.proc = _FakeProc()
    job.status = "done"
    assert job.interrupt() is False


def test_interrupt_no_proc_returns_false():
    job = runner.Job("i3", 555)
    assert job.interrupt() is False


def test_interrupted_result_is_not_error():
    job = runner.Job("i4", 555)
    job.interrupted = True
    runner._handle_event(job, {"type": "result", "result": "partial", "is_error": True})
    assert job.status == "done"


# --- model/effort request validation ----------------------------------------

def test_normalize_model_effort_valid():
    assert normalize_model_effort("opus", "high") == (True, "opus", "high")


def test_normalize_model_effort_blank_dropped():
    assert normalize_model_effort("", "") == (True, None, None)


def test_normalize_model_effort_unknown_model_rejected():
    assert normalize_model_effort("gpt-5", "high") == (False, None, None)


def test_normalize_model_effort_unknown_effort_dropped():
    assert normalize_model_effort("opus", "ultra") == (True, "opus", None)


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
