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


def test_lists_exclude_sessions_idle_past_window():
    """Lists (sidebar/history) drop sessions idle past LIST_MAX_AGE_SECS,
    but the session stays resumable (latest_session) and viewable (get_session)."""
    from contextlib import closing
    chat = 7733
    stale = store.LIST_MAX_AGE_SECS + 86400   # one day past the window
    fresh = store.create_session(chat, "/stale_proj")
    old = store.create_session(chat, "/stale_proj")
    with closing(store._connect()) as c:  # backdate `old` past the window
        c.execute("UPDATE sessions SET updated=? WHERE id=?",
                  (time.time() - stale, old["id"]))
        c.commit()

    all_ids = {r["id"] for r in store.list_sessions_all(chat)}
    assert fresh["id"] in all_ids
    assert old["id"] not in all_ids                                  # hidden from sidebar
    assert old["id"] not in {r["id"] for r in store.list_sessions(chat, "/stale_proj")}
    assert old["id"] not in {r["id"] for r in store.history(chat)}   # hidden from history

    # …but complete history is preserved: still resumable + viewable by id.
    only_old = store.create_session(chat, "/ghost_proj")
    with closing(store._connect()) as c:
        c.execute("UPDATE sessions SET updated=? WHERE id=?",
                  (time.time() - stale, only_old["id"]))
        c.commit()
    assert store.latest_session(chat, "/ghost_proj")["id"] == only_old["id"]
    assert store.get_session(old["id"]) is not None


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


def test_empty_allowlist_fails_closed(monkeypatch):
    """An empty ALLOWED_CHAT_IDS must reject everyone — this server is reachable
    over the public tunnel, so empty must never mean 'allow anyone'."""
    monkeypatch.setattr(config, "ALLOWED_CHAT_IDS", set())
    assert validate_init_data(make_init_data(config.TOKEN, 555)) is None


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


def test_steer_writes_user_message_to_the_live_turn():
    """A steer must reach the RUNNING job's stdin as a stream-json user message
    (that's what the CLI folds into the in-flight turn), and must refuse when the
    session has no live job — the caller queues it instead."""
    class FakeStdin:
        closed = False
        def __init__(self): self.lines = []
        def write(self, s): self.lines.append(s)
        def flush(self): pass

    class FakeProc:
        def __init__(self): self.stdin = FakeStdin()

    saved = dict(runner._jobs)
    runner._jobs.clear()
    try:
        job = runner.Job("j-steer", 555, "sess-steer")
        job.proc = FakeProc()
        runner._register(job)

        assert runner.steer("sess-steer", "actually, use tabs") is True
        sent = json.loads(job.proc.stdin.lines[-1])
        assert sent == {"type": "user",
                        "message": {"role": "user", "content": "actually, use tabs"}}
        assert job.events[-1] == {"type": "steer", "text": "actually, use tabs"}

        assert runner.steer("other-session", "hi") is False   # no such job
        job.status = "done"
        assert runner.steer("sess-steer", "hi") is False       # turn already over
    finally:
        runner._jobs.clear()
        runner._jobs.update(saved)


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


def test_format_answers_free_text():
    qs = [{"header": "Approach", "question": "Which?"}]
    both = runner._format_answers(qs, [{"header": "Approach", "labels": ["A"], "notes": "but cache it"}])
    assert "A" in both and "but cache it" in both
    only = runner._format_answers(qs, [{"header": "Approach", "labels": [], "notes": "do C instead"}])
    assert "do C instead" in only and "did not select" not in only


def test_interactive_base_cmd():
    cmd = runner._base_cmd("hello-prompt", 555, stream=True, interactive=True)
    assert "--input-format" in cmd and "stream-json" in cmd
    assert "--permission-prompt-tool" in cmd and "stdio" in cmd
    assert "--permission-mode" in cmd
    assert "hello-prompt" not in cmd          # prompt goes via stdin, not argv
    assert "acceptEdits" not in cmd            # EXTRA_CLAUDE_ARGS skipped


def test_blocking_base_cmd_unchanged():
    cmd = runner._base_cmd("hi", 555, stream=False)
    # cmd[0] is the resolved claude launcher (may be an absolute path), not the
    # literal "claude"; the contract is that -p and the prompt come next.
    assert os.path.basename(cmd[0]) == "claude"
    assert cmd[1:3] == ["-p", "hi"]
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
    assert set(b) == {"id", "title", "project", "updated", "archived",
                      "origin", "cwd", "branch", "fallback_policy", "goal",
                      "lifecycle"}
    assert b["id"] == s["id"] and b["project"] == "p6"
    assert isinstance(b["branch"], str)   # "" when cwd has no repo
    assert b["goal"] is None              # parsed from the column, not the raw JSON
    assert b["lifecycle"] is None         # a fresh session is active


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


def test_dashboard_token_gate_disabled_when_empty(monkeypatch):
    """DASH_TOKEN="" disables the gate so the dashboard opens with no ?token=;
    _tok_ok then accepts any token (localhost-only convenience)."""
    from bridge.dashboard import server as dash
    monkeypatch.setattr(config, "DASH_TOKEN", "")
    assert dash._tok_ok("") is True
    assert dash._tok_ok("anything") is True


def test_dashboard_server_starts_in_requested_project_dir():
    """Regression: the Design tab passes the project it is showing, and the dev
    server must start in THAT project's dir — not the globally-active project,
    which (when unset) falls back to BASE_PATH and runs `pnpm install` in the
    wrong place (ERR_PNPM_NO_PKG_MANIFEST)."""
    from bridge.dashboard import server as dash
    from bridge import devserver, state

    proj = "ibgroup_designrun"
    proj_dir = os.path.join(config.BASE_PATH, proj)   # BASE_PATH=/tmp in tests
    os.makedirs(proj_dir, exist_ok=True)
    chat = 909
    state.active.pop(chat, None)                       # no active project set

    captured = {}
    orig = devserver.start
    devserver.start = (lambda cwd, cmd, project="", branch="":
                       captured.update(cmd=cmd, cwd=cwd) or "ok")
    try:
        h = dash.Handler.__new__(dash.Handler)
        h._json = lambda obj, code=200: None           # swallow the HTTP response
        h._server(chat, {"action": "start", "cmd": "pnpm install",
                         "project": proj})
    finally:
        devserver.start = orig
        try:
            os.rmdir(proj_dir)
        except OSError:
            pass

    assert captured["cwd"] == os.path.realpath(proj_dir)   # named project…
    assert captured["cwd"] != config.BASE_PATH             # …not the BASE_PATH fallback


def test_handle_task_journals_bot_turn():
    from bridge import state
    state.active[777] = "/tmp"                       # BASE_PATH=/tmp -> project_key "/"
    orig = (runner.send, runner.typing, runner.run_blocking)
    runner.send = lambda *a, **k: None
    runner.typing = lambda *a, **k: None
    runner.run_blocking = lambda chat_id, prompt, resume_id=None, **kw: ("answer", "claude-sid", 0.01, False)
    session = store.ensure_session(777, state.project_key(777))
    state.acquire_run(session["id"], 777)            # handle_task assumes caller holds the slot
    try:
        runner.handle_task(777, "do the thing", session)
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


def test_normalize_model_effort_fable_accepted():
    assert normalize_model_effort("fable", "high") == (True, "fable", "high")


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


def test_machine_transcript_mtime():
    with tempfile.TemporaryDirectory() as d:
        old = machine.PROJECTS_DIR
        machine.PROJECTS_DIR = d
        try:
            cwd = "/home/u/projects/my_app.v2"  # '/', '_', '.' all collapse to '-'
            enc = "-home-u-projects-my-app-v2"
            os.makedirs(os.path.join(d, enc))
            tx = os.path.join(d, enc, "sid123.jsonl")
            open(tx, "w").close()
            os.utime(tx, (1000.0, 12345.0))
            assert machine._transcript_mtime("sid123", cwd) == 12345.0
            assert machine._transcript_mtime("missing", cwd) is None
            assert machine._transcript_mtime("", cwd) is None
        finally:
            machine.PROJECTS_DIR = old


def test_machine_last_active_prefers_transcript_over_frozen_registry():
    # The bug: VS Code freezes its registry file at start, so its mtime is stale.
    # last_active must come from the transcript (appended to on every turn).
    with tempfile.TemporaryDirectory() as sd, tempfile.TemporaryDirectory() as pd:
        old_s, old_p = machine.SESSIONS_DIR, machine.PROJECTS_DIR
        machine.SESSIONS_DIR, machine.PROJECTS_DIR = sd, pd
        try:
            cwd, sid = "/home/u/proj/app", "abc"
            reg = os.path.join(sd, f"{os.getpid()}.json")  # this pid is alive
            with open(reg, "w") as f:
                json.dump({"pid": os.getpid(), "sessionId": sid, "cwd": cwd,
                           "startedAt": 1782000000000, "entrypoint": "claude-vscode"}, f)
            os.utime(reg, (1000.0, 1000.0))                # registry "frozen at start"
            enc = "-home-u-proj-app"
            os.makedirs(os.path.join(pd, enc))
            tx = os.path.join(pd, enc, f"{sid}.jsonl")
            open(tx, "w").close()
            os.utime(tx, (5000.0, 5000.0))                 # transcript is newer
            rows = machine.list_running()
            assert len(rows) == 1
            assert rows[0]["last_active"] == 5000.0        # transcript wins, not 1000
        finally:
            machine.SESSIONS_DIR, machine.PROJECTS_DIR = old_s, old_p


def test_machine_skips_sdk_children():
    # The bug: newer CLIs register the bridge's own `claude -p` children, so every
    # running chat showed twice — once as a bridge job, once as an external row.
    with tempfile.TemporaryDirectory() as sd:
        old = machine.SESSIONS_DIR
        machine.SESSIONS_DIR = sd
        try:
            for name, entry in (("1.json", "sdk-cli"), ("2.json", "claude-vscode")):
                with open(os.path.join(sd, name), "w") as f:
                    json.dump({"pid": os.getpid(), "sessionId": name[0],
                               "cwd": "/home/u/proj/app", "entrypoint": entry}, f)
            rows = machine.list_running()
            assert [r["source"] for r in rows] == ["vscode"]
        finally:
            machine.SESSIONS_DIR = old


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


# --- per-repo history + model capture ---------------------------------------

def test_store_history_aggregates():
    s = store.create_session(557, "hrepo")
    store.start_turn(s["id"], "h1", "first", [], model="opus")
    store.finish_turn("h1", "done", 0.02, 5)
    store.start_turn(s["id"], "h2", "second", [], model="sonnet")
    store.finish_turn("h2", "done", 0.03, 7)
    row = next(r for r in store.history(557) if r["id"] == s["id"])
    assert row["turn_count"] == 2
    assert abs(row["total_cost"] - 0.05) < 1e-9
    assert row["models"] == ["opus", "sonnet"]            # sorted, distinct
    assert row["project"] == "hrepo"
    assert row["last_activity"] >= row["created"]


def test_store_history_excludes_archived_by_default():
    s = store.create_session(558, "arepo")
    store.start_turn(s["id"], "a1", "x", [])
    store.archive(s["id"])
    assert all(r["id"] != s["id"] for r in store.history(558))
    assert any(r["id"] == s["id"] for r in store.history(558, include_archived=True))


def test_store_history_session_with_no_turns():
    s = store.create_session(560, "empty")
    row = next(r for r in store.history(560) if r["id"] == s["id"])
    assert row["turn_count"] == 0 and row["total_cost"] == 0 and row["models"] == []
    assert row["last_activity"] == s["updated"]            # falls back to session.updated


def test_store_init_idempotent_and_model_persisted():
    store.init()                                           # second call must not raise
    s = store.create_session(559, "mrepo")
    store.start_turn(s["id"], "m1", "x", [], model="haiku")
    row = next(r for r in store.history(559) if r["id"] == s["id"])
    assert row["models"] == ["haiku"]                      # migration applied, model stored


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


# --- cross-surface continuity: store extensions -----------------------------

def test_store_migration_adds_origin_cwd_permission_columns():
    import sqlite3
    store.init()                                            # idempotent
    con = sqlite3.connect(config.BRIDGE_DB)
    cols = {r[1] for r in con.execute("PRAGMA table_info(sessions)").fetchall()}
    con.close()
    assert {"origin", "cwd", "permission_mode"} <= cols


def test_store_create_session_records_origin_cwd_permission():
    s = store.create_session(561, "proj", origin="dashboard", cwd="/tmp/proj",
                             permission_mode="bypassPermissions")
    assert s["origin"] == "dashboard"
    assert s["cwd"] == "/tmp/proj"
    assert s["permission_mode"] == "bypassPermissions"


def test_store_create_session_defaults_new_columns_to_none():
    s = store.create_session(561, "proj2")
    assert s["origin"] is None and s["cwd"] is None and s["permission_mode"] is None


def test_store_upsert_native_session_creates_row_keyed_by_uuid():
    uid = "11111111-2222-3333-4444-555555555555"
    s = store.upsert_native_session(uid, 562, "/np", "/tmp/np", title="hi there")
    assert s["id"] == uid and s["claude_session_id"] == uid
    assert s["origin"] == "vscode" and s["cwd"] == "/tmp/np"
    assert s["project"] == "/np" and s["title"] == "hi there"
    assert store.get_by_claude_session_id(uid)["id"] == uid


def test_store_upsert_native_session_dedups_and_refreshes():
    uid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    store.upsert_native_session(uid, 563, "/np", "/tmp/np", title="first", updated=100.0)
    store.upsert_native_session(uid, 563, "/np", "/tmp/np", title="ignored", updated=200.0)
    # read unfiltered: these rows use epoch-y timestamps to exercise mtime refresh,
    # which would otherwise be hidden by the 3-day recency cutoff.
    rows = [r for r in store.list_sessions_all(563, max_age_secs=None)
            if r["claude_session_id"] == uid]
    assert len(rows) == 1                                   # no duplicate row
    assert rows[0]["updated"] == 200.0                      # mtime refreshed
    assert rows[0]["title"] == "first"                      # user/first-msg title preserved


def test_store_upsert_native_refreshes_noise_title():
    uid = "noise-uuid-1"
    store.upsert_native_session(uid, 565, "/p", "/tmp",
                                title="<ide_opened_file>x</ide_opened_file>")
    store.upsert_native_session(uid, 565, "/p", "/tmp", title="clean prompt")
    rows = [r for r in store.list_sessions_all(565, max_age_secs=None)
            if r["claude_session_id"] == uid]
    assert rows[0]["title"] == "clean prompt"      # tag-noise title healed on rescan


def test_store_set_permission_mode_and_cwd():
    s = store.create_session(564, "pp")
    store.set_permission_mode(s["id"], "bypassPermissions")
    store.set_cwd(s["id"], "/tmp/pp")
    g = store.get_session(s["id"])
    assert g["permission_mode"] == "bypassPermissions" and g["cwd"] == "/tmp/pp"


def test_ensure_session_create_passes_origin_cwd_permission():
    s = store.ensure_session(570, "/newproj", None, origin="dashboard",
                             cwd="/tmp/newproj", permission_mode="bypassPermissions")
    assert s["origin"] == "dashboard" and s["cwd"] == "/tmp/newproj"
    assert s["permission_mode"] == "bypassPermissions"


def test_ensure_session_existing_ignores_create_args():
    a = store.create_session(571, "/p")
    s = store.ensure_session(571, "/p", a["id"], origin="miniapp", permission_mode="plan")
    assert s["id"] == a["id"] and s["origin"] is None        # existing row untouched


# --- runner: cross-surface run context (cwd + permission per session) --------

def test_resolve_context_new_session_gets_surface_default_permission():
    sess, cwd, perm = runner._resolve_run_context(
        572, "/tmp/ctxnew", session_id=None, permission_mode=None, origin="dashboard")
    assert sess["permission_mode"] == config.NEW_SESSION_PERMISSION_MODE
    assert perm == config.NEW_SESSION_PERMISSION_MODE
    assert cwd == "/tmp/ctxnew" and sess["cwd"] == "/tmp/ctxnew"
    assert sess["origin"] == "dashboard"


def test_resolve_context_resumes_session_with_its_own_cwd_and_permission():
    os.makedirs("/tmp/realdir", exist_ok=True)   # a session's run cwd must exist on disk
    s = store.create_session(573, "/proj", origin="vscode", cwd="/tmp/realdir",
                             permission_mode="plan")
    sess, cwd, perm = runner._resolve_run_context(
        573, "/tmp/other", session_id=s["id"], permission_mode=None, origin="miniapp")
    assert sess["id"] == s["id"]
    assert cwd == "/tmp/realdir"               # the session's own cwd, not the chat's
    assert perm == "plan"                      # the session's stored permission


def test_resolve_context_explicit_permission_overrides_session():
    s = store.create_session(574, "/proj", cwd="/tmp/d", permission_mode="plan")
    _, _, perm = runner._resolve_run_context(
        574, "/tmp/d", session_id=s["id"], permission_mode="acceptEdits", origin="miniapp")
    assert perm == "acceptEdits"


# --- adopt-on-continue (native session -> store) ----------------------------

def test_store_set_origin():
    s = store.create_session(580, "/p", origin="vscode")
    store.set_origin(s["id"], "bridge")
    assert store.get_session(s["id"])["origin"] == "bridge"


def test_store_import_transcript_loads_turns_events_idempotent():
    s = store.create_session(581, "/p")
    turns = [{"id": "u1", "seq": 0, "prompt": "hi", "attachments": [], "status": "done",
              "cost": None, "elapsed": None, "started": 1.0, "model": "opus"}]
    events = [{"type": "text", "text": "yo", "seq": 0, "turn_id": "u1"}]
    assert store.import_transcript(s["id"], turns, events) is True
    t = store.transcript(s["id"])
    assert [x["id"] for x in t["turns"]] == ["u1"]
    assert t["turns"][0]["prompt"] == "hi" and t["turns"][0]["model"] == "opus"
    assert [e["type"] for e in t["events"]] == ["text"]
    assert store.import_transcript(s["id"], turns, events) is False   # idempotent no-op
    assert len(store.transcript(s["id"])["turns"]) == 1


def test_transcript_for_bridge_falls_back_to_jsonl_when_store_empty(monkeypatch):
    import tempfile
    from bridge import transcript_jsonl as _T
    from bridge.miniapp.server import transcript_for
    root = tempfile.mkdtemp()
    monkeypatch.setattr(_T, "PROJECTS_DIR", root)   # auto-restored (was leaking)
    uid = "fallback-uuid-1"
    sub = os.path.join(root, "p")
    os.makedirs(sub)
    with open(os.path.join(sub, uid + ".jsonl"), "w") as f:
        f.write(json.dumps({"type": "user", "uuid": "x1", "cwd": "/tmp",
                            "message": {"role": "user", "content": "jsonl only"}}) + "\n")
    s = store.create_session(590, "/p")                 # origin None, empty store turns
    store.set_claude_session_id(s["id"], uid)
    t = transcript_for(store.get_session(s["id"]))
    assert any(x["prompt"] == "jsonl only" for x in t["turns"])   # fell back to JSONL


def test_resolve_context_adopts_native_session_into_store(monkeypatch):
    import tempfile
    from bridge import transcript_jsonl as _T
    root = tempfile.mkdtemp()
    monkeypatch.setattr(_T, "PROJECTS_DIR", root)   # auto-restored (was leaking)
    uid = "adopt-uuid-1"
    sub = os.path.join(root, "p")
    os.makedirs(sub)
    with open(os.path.join(sub, uid + ".jsonl"), "w") as f:
        f.write(json.dumps({"type": "user", "uuid": "j1", "cwd": "/tmp/realcwd",
                            "message": {"role": "user", "content": "orig vscode msg"}}) + "\n")
        f.write(json.dumps({"type": "assistant", "uuid": "j2", "message": {
            "role": "assistant", "content": [{"type": "text", "text": "vscode reply"}]}}) + "\n")
    os.makedirs("/tmp/realcwd", exist_ok=True)   # a session's run cwd must exist on disk
    s = store.create_session(582, "/p", origin="vscode", cwd="/tmp/realcwd")
    store.set_claude_session_id(s["id"], uid)
    sess, cwd, perm = runner._resolve_run_context(
        582, "/tmp/other", session_id=s["id"], permission_mode=None, origin="miniapp")
    assert sess["origin"] == "bridge"                          # adopted into the store
    assert cwd == "/tmp/realcwd"                               # native cwd preserved
    assert perm == config.NEW_SESSION_PERMISSION_MODE          # continued from miniapp -> full
    tr = store.transcript(s["id"])
    assert any(t["prompt"] == "orig vscode msg" for t in tr["turns"])   # history imported


def test_run_context_falls_back_when_session_cwd_removed():
    """A session's stored cwd can be a git worktree that was later removed. The run
    must fall back to the project dir, not pass the dead path to subprocess (which
    raises FileNotFoundError, misreported as '`claude` not found on PATH')."""
    from bridge import runner
    chat = 8123
    s = store.create_session(chat, "/wt_proj", origin="dashboard",
                             cwd="/tmp/removed-worktree-zzz")   # does not exist
    sess, cwd, perm = runner._finalize_run_context(
        s, "/tmp", permission_mode=None, origin="dashboard")    # /tmp = BASE_PATH, exists
    assert cwd == "/tmp"                                         # fell back to project dir


# --- websocket framing (terminal transport) ---------------------------------

def test_ws_accept_key_rfc_example():
    from bridge import wsutil
    # RFC 6455 §1.3 canonical handshake example.
    assert wsutil.accept_key("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def test_ws_encode_frame_small_unmasked():
    from bridge import wsutil
    # FIN + binary opcode (0x82), no mask bit, len=2, payload — server frames unmasked.
    assert wsutil.encode_frame(b"hi", wsutil.OP_BINARY) == b"\x82\x02hi"


def test_ws_encode_frame_126_extended_length():
    import struct
    from bridge import wsutil
    payload = b"x" * 200
    f = wsutil.encode_frame(payload, wsutil.OP_BINARY)
    assert f[0] == 0x82 and f[1] == 126
    assert struct.unpack(">H", f[2:4])[0] == 200
    assert f[4:] == payload


def test_ws_encode_frame_64bit_length():
    import struct
    from bridge import wsutil
    payload = b"y" * 70000
    f = wsutil.encode_frame(payload, wsutil.OP_BINARY)
    assert f[1] == 127
    assert struct.unpack(">Q", f[2:10])[0] == 70000
    assert f[10:] == payload


def test_ws_decode_masked_client_text_frame():
    import io
    from bridge import wsutil
    mask, payload = b"\x01\x02\x03\x04", b"ping"
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    frame = bytes([0x81, 0x80 | len(payload)]) + mask + masked
    assert wsutil.decode_frame(io.BytesIO(frame)) == (wsutil.OP_TEXT, b"ping")


def test_ws_decode_close_frame():
    import io
    from bridge import wsutil
    frame = bytes([0x88, 0x80]) + b"\x00\x00\x00\x00"   # close, masked, zero-length
    op, _ = wsutil.decode_frame(io.BytesIO(frame))
    assert op == wsutil.OP_CLOSE


def test_ws_decode_eof_returns_none():
    import io
    from bridge import wsutil
    assert wsutil.decode_frame(io.BytesIO(b"")) is None


# --- terminals (PTY registry) ------------------------------------------------

def _wait_for(pred, secs=3.0):
    import time as _t
    end = _t.time() + secs
    while _t.time() < end:
        if pred():
            return True
        _t.sleep(0.05)
    return pred()


def test_terminal_cap_enforced():
    from bridge import terminals
    orig = terminals.MAX_TERMS
    terminals.MAX_TERMS = 2
    made = []
    try:
        made.append(terminals.create("/tmp")["id"])
        made.append(terminals.create("/tmp")["id"])
        r = terminals.create("/tmp")
        assert "id" not in r and r.get("error")
    finally:
        terminals.MAX_TERMS = orig
        for t in made:
            terminals.close(t)


def test_terminal_create_info_close_lifecycle():
    from bridge import terminals
    tid = terminals.create("/tmp", project="projL")["id"]
    info = {t["id"]: t for t in terminals.info(None)}
    assert tid in info and info[tid]["alive"] is True
    assert terminals.close(tid)["ok"] is True
    assert all(t["id"] != tid for t in terminals.info(None))   # dropped synchronously


def test_terminal_info_filters_by_project():
    from bridge import terminals
    a = terminals.create("/tmp", project="projA")["id"]
    b = terminals.create("/tmp", project="projB")["id"]
    try:
        ids_a = {t["id"] for t in terminals.info("projA")}
        assert a in ids_a and b not in ids_a
        assert {t["id"] for t in terminals.info(None)} >= {a, b}
    finally:
        terminals.close(a)
        terminals.close(b)


def test_terminal_resize_reflected_in_info():
    from bridge import terminals
    tid = terminals.create("/tmp", cols=80, rows=24)["id"]
    try:
        terminals.resize(tid, 120, 40)
        info = {t["id"]: t for t in terminals.info(None)}[tid]
        assert info["cols"] == 120 and info["rows"] == 40
    finally:
        terminals.close(tid)


def test_terminal_write_echoes_through_attached_socket():
    from bridge import terminals
    orig_shell = terminals._DEFAULT_SHELL
    terminals._DEFAULT_SHELL = "/bin/sh"            # fast, deterministic (no heavy rc)
    got = bytearray()
    tid = terminals.create("/tmp")["id"]
    try:
        terminals.attach(tid, lambda b: got.extend(b))
        terminals.write(tid, b"echo READY_MARK\n")
        assert _wait_for(lambda: b"READY_MARK" in bytes(got))
    finally:
        terminals.close(tid)
        terminals._DEFAULT_SHELL = orig_shell


def test_dashboard_ws_authorization():
    from bridge.dashboard import server as dash
    host = f"127.0.0.1:{config.DASH_PORT}"
    origin = f"http://{host}"
    assert dash._ws_authorized(host, origin, config.DASH_TOKEN) is True
    assert dash._ws_authorized("evil.example", origin, config.DASH_TOKEN) is False
    assert dash._ws_authorized(host, "http://evil.example", config.DASH_TOKEN) is False
    assert dash._ws_authorized(host, origin, "badtoken") is False


def test_current_branch_cached_dedupes_within_ttl():
    from bridge import git
    calls = []
    real = git.current_branch
    git.current_branch = lambda cwd: (calls.append(cwd), "feat/x")[1]
    git._branch_cache.clear()
    try:
        assert git.current_branch_cached("/wt") == "feat/x"
        assert git.current_branch_cached("/wt") == "feat/x"
        assert len(calls) == 1            # second call served from cache
        assert git.current_branch_cached("") == ""   # empty cwd short-circuits
    finally:
        git.current_branch = real
        git._branch_cache.clear()


def test_project_config_prod_url_roundtrip():
    from bridge import project_config
    project_config.set_prod_url("proj/pu", "https://app.example.com/")
    assert project_config.prod_url("proj/pu") == "https://app.example.com/"
    project_config.set_prod_url("proj/pu", "")     # blank clears
    assert project_config.prod_url("proj/pu") is None


def test_allowed_screenshot_url():
    from bridge.dashboard.server import _allowed_screenshot_url
    # dev_ports is the set of localhost ports a dev server bound (concurrent previews).
    assert _allowed_screenshot_url("http://localhost:3000", {3000}, None)
    assert _allowed_screenshot_url("http://127.0.0.1:3000/x", {3000}, None)
    assert _allowed_screenshot_url("http://localhost:5174", {3000, 5174}, None)  # another preview
    assert not _allowed_screenshot_url("http://localhost:9999", {3000}, None)
    assert _allowed_screenshot_url("https://app.example.com/p", {3000}, "https://app.example.com")
    assert not _allowed_screenshot_url("https://evil.example.com", {3000}, "https://app.example.com")
    assert not _allowed_screenshot_url("file:///etc/passwd", {3000}, None)


# --- auto-resume: only the user may stop a turn ------------------------------

def test_restart_killed_only_for_shutdown_errors(monkeypatch):
    from bridge import state
    job = runner.Job("rk1", 555, "s-rk")
    job.status = "error"
    monkeypatch.setattr(state, "shutting_down", True)
    assert runner._restart_killed(job)
    job.interrupted = True                        # user Stop → not a restart kill
    assert not runner._restart_killed(job)
    job.interrupted, job.timed_out = False, True  # watchdog brake → keep the error
    assert not runner._restart_killed(job)
    job.timed_out, job.status = False, "done"     # finished fine → record it
    assert not runner._restart_killed(job)
    job.status = "error"
    monkeypatch.setattr(state, "shutting_down", False)
    assert not runner._restart_killed(job)        # bridge alive → real error


def test_midrun_crash_auto_resumes_capped(monkeypatch):
    s = store.create_session(555, "p-crash")
    store.set_claude_session_id(s["id"], "csid-crash")
    started = []
    monkeypatch.setattr(runner, "start_streaming_job",
                        lambda *a, **kw: (started.append((a, kw)), object())[1])
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)

    def crashed_turn():
        job = runner.Job(f"jc{len(started)}", 555, s["id"])
        job.status = "error"
        return runner._maybe_auto_resume(job, "/tmp", None, None)

    assert all(crashed_turn() for _ in range(runner.AUTO_RESUME_MAX))  # crashes resume…
    assert not crashed_turn()                     # …until AUTO_RESUME_MAX gives up
    assert len(started) == runner.AUTO_RESUME_MAX
    assert started[0][0][1] == runner.RESUME_NUDGE
    ok = runner.Job("jok", 555, s["id"])          # a healthy turn resets the cap
    ok.status = "done"
    runner._maybe_auto_resume(ok, "/tmp", None, None)
    assert crashed_turn()


def test_timeout_auto_resumes_capped(monkeypatch):
    s = store.create_session(555, "p-timeout")
    store.set_claude_session_id(s["id"], "csid-timeout")
    started, notes = [], []
    monkeypatch.setattr(runner, "start_streaming_job",
                        lambda *a, **kw: (started.append((a, kw)), object())[1])
    monkeypatch.setattr(runner, "_notify", lambda cid, m: notes.append(m))

    def timed_out_turn():
        job = runner.Job(f"jt{len(started)}", 555, s["id"])
        job.status, job.timed_out = "error", True
        job.error_msg = f"⏱️ Timed out after {config.RUN_TIMEOUT // 60} min."
        return runner._maybe_auto_resume(job, "/tmp", None, None)

    # the watchdog no longer ends the task…
    assert all(timed_out_turn() for _ in range(runner.AUTO_RESUME_MAX))
    assert not timed_out_turn()   # …but a turn that only ever times out eventually stops
    assert len(started) == runner.AUTO_RESUME_MAX
    assert started[0][0][1] == runner.TIMEOUT_NUDGE  # distinct from the crash nudge
    assert "cap" in notes[0]
    ok = runner.Job("jtok", 555, s["id"])          # a turn that finishes resets the cap
    ok.status = "done"
    runner._maybe_auto_resume(ok, "/tmp", None, None)
    assert timed_out_turn()


def test_midrun_no_resume_for_user_stop_or_shutdown(monkeypatch):
    from bridge import state
    s = store.create_session(555, "p-noresume")
    store.set_claude_session_id(s["id"], "csid-noresume")

    def boom(*a, **kw):
        raise AssertionError("must not spawn a resume")
    monkeypatch.setattr(runner, "start_streaming_job", boom)

    job = runner.Job("jn", 555, s["id"])
    job.status, job.interrupted = "error", True
    assert not runner._maybe_auto_resume(job, "/tmp", None, None)   # user Stop
    job.interrupted, job.timed_out = False, True
    monkeypatch.setattr(state, "shutting_down", True)
    assert not runner._maybe_auto_resume(job, "/tmp", None, None)   # timed out mid-restart
    job.timed_out = False
    assert not runner._maybe_auto_resume(job, "/tmp", None, None)   # restarting
    monkeypatch.setattr(state, "shutting_down", False)
    fresh = store.create_session(555, "p-noinit")                   # never got an init event
    job2 = runner.Job("jn2", 555, fresh["id"])
    job2.status = "error"
    assert not runner._maybe_auto_resume(job2, "/tmp", None, None)  # no claude session id


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
