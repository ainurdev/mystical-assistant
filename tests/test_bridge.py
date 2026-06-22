"""Unit tests for the trickiest backend logic: Mini App initData auth and the
Claude stream-json event parsing. Run directly: `python tests/test_bridge.py`
(or with pytest). Env is set before importing the package so config picks it up.
"""

import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import config, machine, pubsub, runner, store, usage   # noqa: E402
from bridge.miniapp.server import (                       # noqa: E402
    validate_init_data, normalize_model_effort)

store.init()


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


def test_base_cmd_resumes_when_session_id():
    cmd = runner._base_cmd("p", 555, stream=True, interactive=True,
                           claude_session_id="abc123")
    assert cmd[cmd.index("--resume") + 1] == "abc123"


def test_state_project_key_is_canonical_rel():
    from bridge import state
    assert state.project_key(424242).startswith("/")   # base or /rel


def test_runner_journals_to_store():
    s = store.create_session(555, "p5")
    job = runner.Job("jx", 555, s["id"])
    runner._handle_event(job, {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "hey"}]}})
    runner._handle_event(job, {"type": "result", "result": "ok",
                               "total_cost_usd": 0.02, "session_id": "c1"})
    runner._drain_journal()
    evs = [e["type"] for e in store.transcript(s["id"])["events"]]
    assert "text" in evs and "result" in evs


def test_runner_job_without_session_does_not_journal():
    job = runner.Job("nojournal", 555)            # no store session
    runner._handle_event(job, {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "hi"}]}})
    runner._drain_journal()
    assert job.events and job.store_session_id is None   # in-memory only, no error


def test_session_brief_shape():
    from bridge.miniapp.server import _session_brief
    s = store.create_session(555, "p6")
    b = _session_brief(s)
    assert set(b) == {"id", "title", "project", "updated", "archived"}
    assert b["id"] == s["id"] and b["project"] == "p6"


def test_store_list_sessions_all():
    store.create_session(900, "a")
    store.create_session(900, "b")
    projs = {s["project"] for s in store.list_sessions_all(900)}
    assert {"a", "b"} <= projs


# --- dashboard security ------------------------------------------------------

def test_tunnel_refuses_reserved_ports():
    from bridge import tunnel
    url, msg = tunnel.start_tunnel(config.DASH_PORT)
    assert url is None and "reserved" in msg.lower()
    url2, _ = tunnel.start_tunnel(config.MINIAPP_PORT)
    assert url2 is None


def test_dashboard_security_helpers():
    from bridge.dashboard import server as dash
    assert dash._tok_ok(config.DASH_TOKEN) is True
    assert dash._tok_ok("nope") is False
    assert dash._tok_ok("") is False
    assert f"127.0.0.1:{config.DASH_PORT}" in dash._HOSTS
    assert f"http://localhost:{config.DASH_PORT}" in dash._ORIGINS


def test_handle_task_journals_bot_turn():
    from bridge import state
    state.active[777] = "/tmp"                       # BASE_PATH=/tmp -> project_key "/"
    orig = (runner.send, runner.typing, runner.run_blocking)
    runner.send = lambda *a, **k: None
    runner.typing = lambda *a, **k: None
    runner.run_blocking = lambda chat_id, prompt, resume_id=None: ("answer", "claude-sid", 0.01, False)
    state.busy.acquire()                             # handle_task assumes caller holds busy
    state.busy_chat = 777
    try:
        runner.handle_task(777, "do the thing")
    finally:
        runner.send, runner.typing, runner.run_blocking = orig
    s = store.latest_session(777, state.project_key(777))
    assert s and s["claude_session_id"] == "claude-sid"
    assert "result" in [e["type"] for e in store.transcript(s["id"])["events"]]


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


# --- session store ----------------------------------------------------------

def test_store_create_and_get_session():
    s = store.create_session(555, "org/repo")
    assert s["chat_id"] == 555 and s["project"] == "org/repo" and s["archived"] == 0
    got = store.get_session(s["id"])
    assert got["id"] == s["id"] and got["claude_session_id"] is None


def test_store_latest_and_ensure():
    a = store.create_session(555, "p1")
    b = store.create_session(555, "p1")
    assert store.latest_session(555, "p1")["id"] == b["id"]
    assert store.ensure_session(555, "p1", a["id"])["id"] == a["id"]
    assert store.ensure_session(555, "p2")["project"] == "p2"   # creates one


def test_store_archive_and_resume_id():
    s = store.create_session(555, "p3")
    store.set_claude_session_id(s["id"], "claude-xyz")
    store.archive(s["id"])
    assert store.get_session(s["id"])["claude_session_id"] == "claude-xyz"
    assert store.get_session(s["id"])["archived"] == 1
    assert all(x["id"] != s["id"] for x in store.list_sessions(555, "p3"))


def test_store_turns_events_transcript():
    s = store.create_session(555, "p4")
    store.start_turn(s["id"], "job1", "hello world", [])
    assert store.get_session(s["id"])["title"]              # auto-titled
    seq0 = store.append_event(s["id"], "job1", {"type": "text", "text": "hi"})
    seq1 = store.append_event(s["id"], "job1", {"type": "result", "result": "done"})
    assert (seq0, seq1) == (0, 1)
    store.finish_turn("job1", "done", 0.01, 3)
    t = store.transcript(s["id"], cursor=0)
    assert [e["type"] for e in t["events"]] == ["text", "result"]
    assert t["next_cursor"] == 2 and t["turns"][0]["status"] == "done"
    assert t["turns"][0]["attachments"] == []
    assert store.transcript(s["id"], cursor=1)["events"][0]["type"] == "result"


# --- machine: running external sessions -------------------------------------

def test_machine_row_vscode_presence_only():
    row = machine._row({"sessionId": "s1", "pid": 4242, "cwd": "/proj/foo",
                        "startedAt": 1782065470782, "entrypoint": "claude-vscode"})
    assert row["source"] == "vscode" and row["project"] == "foo"
    assert row["status"] is None and row["waiting_for"] is None
    assert abs(row["started"] - 1782065470.782) < 1          # ms -> s


def test_machine_row_cli_status_and_home_shortened():
    home = os.path.expanduser("~")
    row = machine._row({"sessionId": "s", "pid": 1, "cwd": home + "/code/x",
                        "startedAt": 1782065470782, "entrypoint": "cli",
                        "status": "waiting", "waitingFor": "dialog open"})
    assert row["cwd"] == "~/code/x" and row["source"] == "cli"
    assert row["status"] == "waiting" and row["waiting_for"] == "dialog open"


def test_machine_row_skips_incomplete():
    assert machine._row({"pid": 1}) is None                  # no sessionId
    assert machine._row({"sessionId": "s"}) is None          # no pid


def test_machine_alive():
    assert machine._alive(os.getpid()) is True
    assert machine._alive(2_000_000_000) is False
    assert machine._alive("nope") is False


# --- usage normalization ----------------------------------------------------

_USAGE_SAMPLE = {
    "five_hour": {"utilization": 28.0, "resets_at": "2026-06-23T01:49:59+00:00"},
    "seven_day": {"utilization": 51.4, "resets_at": "2026-06-24T11:59:59+00:00"},
    "limits": [
        {"kind": "session", "group": "session", "percent": 28, "severity": "normal",
         "resets_at": "2026-06-23T01:49:59+00:00", "is_active": False, "scope": None},
        {"kind": "weekly_all", "group": "weekly", "percent": 51, "severity": "warning",
         "resets_at": "2026-06-24T11:59:59+00:00", "is_active": True, "scope": None},
    ],
}


def test_usage_normalize():
    u = usage._normalize(_USAGE_SAMPLE)
    assert u["available"] is True
    assert u["five_hour"] == {"percent": 28, "resets_at": "2026-06-23T01:49:59+00:00",
                              "severity": "normal"}
    assert u["seven_day"]["percent"] == 51 and u["seven_day"]["severity"] == "warning"
    assert all(set(l) == {"kind", "group", "percent", "severity", "resets_at",
                          "is_active"} for l in u["limits"])   # 'scope' dropped


def test_usage_normalize_missing_buckets():
    u = usage._normalize({"limits": []})
    assert u["available"] is True
    assert u["five_hour"] is None and u["seven_day"] is None


# --- store: running session ids (badge) -------------------------------------

def test_store_running_session_ids():
    s = store.create_session(556, "rp")
    other = store.create_session(556, "rp")
    store.start_turn(s["id"], "rt1", "go", [])               # leaves status 'running'
    store.start_turn(other["id"], "rt2", "go", [])
    store.finish_turn("rt2", "done", 0.0, 1)
    ids = store.running_session_ids(556)
    assert s["id"] in ids and other["id"] not in ids
    assert store.running_session_ids(424243) == []           # scoped by chat


# --- pubsub -----------------------------------------------------------------

def test_pubsub_basic_and_overflow():
    q = pubsub.subscribe("t1")
    pubsub.publish("t1", {"n": 1})
    assert q.get_nowait() == {"n": 1}
    for i in range(600):
        pubsub.publish("t1", {"n": i})
    assert q.get_nowait() is pubsub.RESYNC      # backlog collapsed to a resync
    pubsub.unsubscribe("t1", q)
    pubsub.publish("t1", {"n": 2})              # no subscribers -> no error


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
