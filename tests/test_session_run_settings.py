"""Session run settings: a session row carries the model and permission mode last
picked for it, and every run path reads them from there.

Logic only (store + runner). The two servers' routes are in
test_session_run_settings_endpoint.py.
Spec: docs/superpowers/specs/session-run-settings-design.md
"""

import json
import os
import sqlite3
import subprocess
import tempfile

from bridge import config, runner, state, store

store.init()

CHAT = 555


# --- storage -------------------------------------------------------------------

def _old_db(path):
    """A DB from before sessions.model: no such column, and turns carry models."""
    c = sqlite3.connect(path)
    c.executescript("""
        CREATE TABLE sessions (id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL,
          project TEXT NOT NULL, claude_session_id TEXT, title TEXT,
          created REAL NOT NULL, updated REAL NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0, permission_mode TEXT);
        CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
          seq INTEGER NOT NULL, prompt TEXT NOT NULL,
          attachments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
          cost REAL, elapsed INTEGER, started REAL NOT NULL, model TEXT);
        INSERT INTO sessions(id, chat_id, project, created, updated, permission_mode)
          VALUES ('picked', 555, '/p', 0, 0, 'bypassPermissions'),
                 ('bot', 555, '/p', 0, 0, NULL),
                 ('blank', 555, '/p', 0, 0, NULL);
        INSERT INTO turns(id, session_id, seq, prompt, status, started, model) VALUES
          ('t0', 'picked', 0, 'a', 'done', 0, 'opus'),
          ('t1', 'picked', 1, 'b', 'done', 0, 'claude-fable-5-1'),
          ('t2', 'picked', 2, 'c', 'error', 0, NULL),
          ('t3', 'bot', 0, 'd', 'done', 0, NULL);
    """)
    c.commit()
    c.close()


def test_an_old_db_gains_the_column_backfilled_from_its_latest_turn(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "old.db")
    _old_db(path)
    monkeypatch.setattr(config, "BRIDGE_DB", path)
    store.init()
    assert store.get_session("picked")["model"] == "claude-fable-5-1"   # newest non-null
    assert store.get_session("bot")["model"] is None                    # nobody picked one
    assert store.get_session("blank")["model"] is None                  # never ran
    assert store.get_session("picked")["permission_mode"] == "bypassPermissions"
    # A second boot neither fails nor re-runs the backfill over a newer pick.
    store.set_run_settings("picked", model="claude-opus-5-5")
    store.init()
    assert store.get_session("picked")["model"] == "claude-opus-5-5"


def test_set_run_settings_writes_only_what_it_is_given():
    s = store.create_session(CHAT, "/srs-set", permission_mode="bypassPermissions")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "bypassPermissions")
    store.set_run_settings(s["id"], permission_mode="default")
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")
    store.set_run_settings(s["id"])                     # nothing given: nothing changes
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")


def test_a_duplicate_keeps_the_sources_picks():
    s = store.create_session(CHAT, "/srs-dup", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    copy = store.duplicate(s["id"])
    assert (copy["model"], copy["permission_mode"]) == ("claude-fable-5-1", "default")


# --- a run resolves to the session's picks --------------------------------------

def _start(monkeypatch, **kw):
    """start_streaming_job up to the spawn: what _run_streaming would have been
    handed, plus the job. Releases the run slot the stubbed turn never will."""
    from bridge import titler
    seen = {}
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming",
                        lambda job, prompt, images, cwd, model, effort, perm, ponytail:
                        seen.update(model=model, perm=perm))
    job = runner.start_streaming_job(CHAT, "go", [], project=config.BASE_PATH, **kw)
    state.release_run(job.store_session_id)
    return job, seen


def test_a_run_with_no_picks_of_its_own_runs_the_sessions(monkeypatch):
    s = store.create_session(CHAT, "/srs-run", cwd=config.BASE_PATH,
                             permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    job, seen = _start(monkeypatch, session_id=s["id"])
    assert seen == {"model": "claude-fable-5-1", "perm": "default"}
    assert job.model == "claude-fable-5-1"
    # The turn records what it ran on, not the blank it was asked with.
    assert store.transcript(s["id"])["turns"][-1]["model"] == "claude-fable-5-1"


def test_a_caller_that_brings_picks_runs_them_and_writes_nothing(monkeypatch):
    """Rivendell, trackers, goals: their values win for the run, and the session
    keeps the picks a person made for it."""
    s = store.create_session(CHAT, "/srs-internal", cwd=config.BASE_PATH,
                             permission_mode="bypassPermissions")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    job, seen = _start(monkeypatch, session_id=s["id"], model="sonnet",
                       permission_mode="manual")
    assert seen == {"model": "sonnet", "perm": "manual"}
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "bypassPermissions")


def test_a_session_nobody_picked_a_model_for_passes_none(monkeypatch):
    s = store.create_session(CHAT, "/srs-none", cwd=config.BASE_PATH)
    job, seen = _start(monkeypatch, session_id=s["id"])
    assert seen["model"] is None and job.model is None   # no --model: the CLI's default


# --- resumes follow the session ---------------------------------------------------

def test_the_turns_end_hands_on_the_model_it_was_switched_to(monkeypatch):
    """Crash resumes, limit parks and goal nudges all take their model from the
    turn's end, so a switch made mid-turn has to be the model they see."""
    from bridge import goals, tailstate, toolsets
    s = store.create_session(CHAT, "/srs-end", cwd=config.BASE_PATH)
    seen = {}
    monkeypatch.setattr(runner, "_maybe_auto_resume",
                        lambda job, cwd, model, effort: seen.update(resume=model) or False)
    monkeypatch.setattr(goals, "continue_after_turn",
                        lambda job, model=None, effort=None: seen.update(goal=model) or False)
    monkeypatch.setattr(tailstate, "kick", lambda job, cwd=None: None)
    monkeypatch.setattr(toolsets, "ready", lambda: True)

    class Popen:                              # the spawn fails at once: straight to finally
        def __init__(self, cmd, **kw):
            raise FileNotFoundError
    monkeypatch.setattr(runner.subprocess, "Popen", Popen)
    job = runner.Job("j-srs-end", CHAT, s["id"])
    job.model = "claude-fable-5-1"            # where a live switch left it
    runner._run_streaming(job, "p", [], config.BASE_PATH, "opus", None, None, None)
    assert seen == {"resume": "claude-fable-5-1", "goal": "claude-fable-5-1"}


def test_a_plugin_run_seeds_its_own_session_with_its_model():
    """Recovery resumes on the session's model (model=None), so a Rivendell
    session, which no person picks for, has to start out carrying its run's."""
    from bridge import rivendell
    w = rivendell.Worker({"id": "srs", "name": "srs", "model": "sonnet"})
    s = store.get_session(w._new_session(config.BASE_PATH))
    assert (s["model"], s["permission_mode"]) == ("sonnet", "bypassPermissions")


# --- switching a running turn ------------------------------------------------------

class _Stdin:
    """The child's stdin: records each JSON line; refuses writes once closed, as a
    real pipe does after claude -p's `result`."""
    closed = False

    def __init__(self):
        self.lines = []

    def write(self, s):
        if self.closed:
            raise ValueError("I/O operation on closed file")
        self.lines.append(json.loads(s))

    def flush(self):
        pass


class _Proc:
    def __init__(self):
        self.stdin = _Stdin()

    def poll(self):
        return None


def _live_job(sid, *pending, job_id=None):
    job = runner.Job(job_id or f"j-{sid}", CHAT, sid)
    job.proc = _Proc()
    for p in pending:
        job.add_pending(dict(p))
    return job


PERM = {"request_id": "p1", "kind": "permission", "tool_name": "Bash",
        "summary": "touch a", "input": {"command": "touch a"}}
QUESTION = {"request_id": "q1", "kind": "question", "tool_name": "AskUserQuestion",
            "questions": []}


def test_interactive_runs_offer_bypass_so_a_switch_can_reach_it():
    """claude 2.1.280 refuses set_permission_mode -> bypassPermissions on a child
    launched without bypass on offer (checked live 2026-10-06)."""
    assert "--allow-dangerously-skip-permissions" in runner._base_cmd(
        "p", CHAT, stream=True, interactive=True, permission_mode="default")
    # The bot's one-shot has no control channel to switch over.
    assert "--allow-dangerously-skip-permissions" not in runner._base_cmd(
        "p", CHAT, stream=False)


def test_root_offers_bypass_only_inside_a_sandbox(monkeypatch):
    """claude exits at startup when the bypass flag runs as root outside a
    deliberate sandbox ("cannot be used with root/sudo privileges"), which would
    fail every turn on a root install; IS_SANDBOX=1 is its own opt-out."""
    def cmd():
        return runner._base_cmd("p", CHAT, stream=True, interactive=True,
                                permission_mode="default")
    monkeypatch.setattr(runner.os, "getuid", lambda: 0)
    monkeypatch.delenv("IS_SANDBOX", raising=False)
    assert "--allow-dangerously-skip-permissions" not in cmd()
    monkeypatch.setenv("IS_SANDBOX", "1")
    assert "--allow-dangerously-skip-permissions" in cmd()
    monkeypatch.setattr(runner.os, "getuid", lambda: 1000)
    monkeypatch.delenv("IS_SANDBOX", raising=False)
    assert "--allow-dangerously-skip-permissions" in cmd()


def test_a_switch_writes_one_control_request_per_setting():
    job = _live_job("s-switch")
    assert job.set_run_settings(model="claude-fable-5-1", permission_mode="acceptEdits")
    assert [l["request"] for l in job.proc.stdin.lines] == [
        {"subtype": "set_model", "model": "claude-fable-5-1"},
        {"subtype": "set_permission_mode", "mode": "acceptEdits"}]
    assert all(l["type"] == "control_request" and l["request_id"]
               for l in job.proc.stdin.lines)
    assert job.model == "claude-fable-5-1"


def test_a_switch_to_bypass_approves_waiting_permissions_not_questions():
    job = _live_job("s-bypass", PERM, QUESTION)
    job.set_run_settings(permission_mode="bypassPermissions")
    switch, allow = job.proc.stdin.lines
    # The mode lands before the approval, so the tool after this one doesn't ask.
    assert switch["request"] == {"subtype": "set_permission_mode", "mode": "bypassPermissions"}
    assert allow == {"type": "control_response", "response": {
        "subtype": "success", "request_id": "p1",
        "response": {"behavior": "allow", "updatedInput": {"command": "touch a"}}}}
    assert [p["request_id"] for p in job.pending] == ["q1"]   # a decision, not a permission
    assert {"type": "permission_resolved", "request_id": "p1",
            "behavior": "allow"} in job.events


def test_other_modes_leave_waiting_cards_alone():
    job = _live_job("s-ask", PERM)
    job.set_run_settings(permission_mode="acceptEdits")
    assert [p["request_id"] for p in job.pending] == ["p1"]


def test_a_turn_with_no_live_channel_says_so_and_approves_nothing():
    """No child yet (boot, or a free agent), or a stdin claude -p closed at
    `result` -- since 666d29a1 such a child can stay up for as long as its
    background agents run. The saved row is then all the next turn needs."""
    assert runner.Job("j-nochild", CHAT, "s-nochild").set_run_settings(model="opus") is False
    done = _live_job("s-closed", PERM)
    done.proc.stdin.closed = True
    assert done.set_run_settings(model="opus", permission_mode="bypassPermissions") is False
    assert [p["request_id"] for p in done.pending] == ["p1"]    # nothing approved blind
    assert done.model is None


def test_apply_run_settings_reaches_the_sessions_newest_job(monkeypatch):
    monkeypatch.setattr(runner, "_jobs", {})
    old = _live_job("s-apply", job_id="j-old")
    new = _live_job("s-apply", job_id="j-new")
    old.started, new.started = 1.0, 2.0
    runner._register(old)
    runner._register(new)
    assert runner.apply_run_settings("s-apply", model="claude-fable-5-1") is True
    assert new.proc.stdin.lines and not old.proc.stdin.lines
    assert runner.apply_run_settings("s-nobody", model="opus") is False


def test_a_refused_control_request_leaves_an_error_row():
    job = runner.Job("j-refused", CHAT)
    runner._handle_event(job, {"type": "control_response", "response": {
        "subtype": "error", "request_id": "r1",
        "error": "Cannot set permission mode to bypassPermissions because it is "
                 "disabled by settings or configuration"}})
    ev = job.events[-1]
    assert (ev["type"], ev["src"], ev["error"]) == ("log", "control", True)
    assert "disabled by settings" in ev["text"]
    runner._handle_event(job, {"type": "control_response", "response": {
        "subtype": "success", "request_id": "r2", "response": {"mode": "plan"}}})
    assert job.events[-1] is ev                               # an accepted one is silent


# --- the bot chat ------------------------------------------------------------------

def _bot_argv(monkeypatch, sid):
    """The claude argv handle_task builds for `sid`, Telegram and side calls stubbed."""
    from bridge import learn, titler
    seen = {}

    def run(cmd, **kw):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(
            {"result": "ok", "session_id": "c-bot", "total_cost_usd": 0}), stderr="")
    monkeypatch.setattr(runner.subprocess, "run", run)
    for name in ("send", "typing", "_graph_pack_for", "_tasks_digest_for",
                 "_dream_pack_for", "_graph_refresh_after_turn"):
        monkeypatch.setattr(runner, name, lambda *a, **k: "")
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(learn, "kick", lambda *a, **k: None)
    monkeypatch.setattr(config, "EXTRA_CLAUDE_ARGS", "--permission-mode acceptEdits")
    runner.handle_task(CHAT, "hi", store.get_session(sid))
    return seen["cmd"]


def test_the_bot_chat_runs_the_sessions_model_and_mode(monkeypatch):
    s = store.create_session(CHAT, "/srs-bot", origin="dashboard",
                             permission_mode="bypassPermissions")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    cmd = _bot_argv(monkeypatch, s["id"])
    assert cmd[cmd.index("--model") + 1] == "claude-fable-5-1"
    assert cmd[cmd.index("--permission-mode") + 1] == "bypassPermissions"
    assert "acceptEdits" not in cmd
    # Its turn row says what it ran on, as a streaming turn's does.
    assert store.transcript(s["id"])["turns"][-1]["model"] == "claude-fable-5-1"


def test_a_session_the_bot_started_keeps_extra_claude_args(monkeypatch):
    s = store.create_session(CHAT, "/srs-bot-own", origin="bot")
    cmd = _bot_argv(monkeypatch, s["id"])
    assert "--model" not in cmd
    assert cmd[cmd.index("--permission-mode") + 1] == "acceptEdits"
