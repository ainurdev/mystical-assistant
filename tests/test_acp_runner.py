"""An agent profile's turn through the runner (runner.AcpJob + bridge/acp.py),
against tests/fake_acp_agent.py: it ends done with its events journaled and
its agent session id kept apart from claude's; Stop works; nothing Claude-only
(steer, auto-resume, the bot) touches it. Spec: profiles-and-acp-agents.md,
"Runner integration" and safety rule 6."""
import json
import os
import subprocess
import sys
import threading
import time

import pytest

from bridge import (acp_agents, config, learn, profiles, project_config, relevance, runner,
                    state, store, tailstate, titler)
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini

store.init()
CHAT = config.DASH_CHAT_ID          # the owner: agent turns run only in its chat
FAKE = os.path.join(os.path.dirname(__file__), "fake_acp_agent.py")
CHUNK = {"update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "hello"}}}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    # env_for() scrubs the child env, so the script rides in the preset's own env.
    monkeypatch.setattr(acp_agents, "PRESETS", (
        {"id": "fake", "label": "Fake", "cmd": [sys.executable, FAKE], "key_env": None,
         "home_env": None, "key_required": False, "login": "fake login", "install": "n/a",
         "env": {"FAKE_ACP_LOG": str(tmp_path / "log.jsonl")}},))
    monkeypatch.setattr(acp_agents, "_resolve", lambda name: name)
    monkeypatch.setattr(acp_agents, "ACCOUNTS_FILE", str(tmp_path / "agent-accounts.json"))
    monkeypatch.setattr(acp_agents, "OPTIONS_FILE", str(tmp_path / "acp-options.json"))
    monkeypatch.setattr(acp_agents, "HOMES", str(tmp_path / "agent-homes"))
    monkeypatch.setattr(acp_agents, "_options", {})
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])   # no `claude mcp list`
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)       # no Telegram
    for mod in (titler, learn, tailstate):                              # no model calls
        monkeypatch.setattr(mod, "kick", lambda *a, **k: None)
    # Journal by draining, never the worker thread: once started it outlives this
    # module, and test_bridge's drain-then-read journal test races it.
    monkeypatch.setattr(runner, "_ensure_journal_thread", lambda: None)
    # These drive the real start_streaming_job: a regression into the Claude path
    # must fail here, never spawn the real CLI.
    monkeypatch.setattr(runner, "_base_cmd", _no_claude)
    yield
    # Nor may a run's tail (auto-resume, pings) outlive these patches.
    end = time.time() + 10
    while time.time() < end and any("_run_streaming" in t.name for t in threading.enumerate()):
        time.sleep(0.02)
    runner._drain_journal()


def _no_claude(*a, **k):
    raise AssertionError("built a claude argv in an agent test")


def _session(chat=CHAT):
    p = profiles.create({"name": "F", "agent": "fake"})
    return store.create_session(chat, "/acp-run", cwd=config.BASE_PATH, profile_id=p["id"])["id"]


def _start(monkeypatch, sid, script, chat=CHAT):
    monkeypatch.setitem(acp_agents.PRESETS[0]["env"], "FAKE_ACP", json.dumps(script))
    return runner.start_streaming_job(chat, "hi", [], project=config.BASE_PATH, session_id=sid)


def _wait(cond, t=10):
    end = time.time() + t
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def _journaled(sid):
    return [e["type"] for e in store.transcript(sid)["events"]]


def _gone(pid):
    """Not running: no such process, or a zombie its new parent hasn't reaped."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(") ", 1)[1].startswith("Z")
    except OSError:
        return True


def _prompting(job):
    """The session is open and the prompt is (about to be) in flight."""
    return _wait(lambda: job.turn is not None and job.turn.sid)


def test_an_agent_turn_runs_end_to_end(monkeypatch):
    sid = _session()
    job = _start(monkeypatch, sid, {"turn": [CHUNK]})
    assert job.exited.wait(10)
    assert isinstance(job, runner.AcpJob) and job.runtime == "acp:fake"
    turn = store.transcript(sid)["turns"][-1]
    assert (turn["status"], turn["runtime"]) == ("done", "acp:fake")
    runner._drain_journal()
    assert _wait(lambda: {"text", "result"} <= set(_journaled(sid)))
    row = store.get_session(sid)
    assert row["agent_session_id"] and row["agent_session_id"] == job.agent_session_id
    assert row["claude_session_id"] is None


def test_a_second_turn_resumes_the_same_agent_session(monkeypatch, tmp_path):
    sid = _session()
    assert _start(monkeypatch, sid, {"turn": [CHUNK]}).exited.wait(10)
    first = store.get_session(sid)["agent_session_id"]
    assert _start(monkeypatch, sid, {"turn": [CHUNK]}).exited.wait(10)
    sent = [json.loads(line) for line in (tmp_path / "log.jsonl").read_text().splitlines()]
    opened = [m for m in sent if m.get("method") in ("session/load", "session/resume")]
    assert opened and opened[0]["params"]["sessionId"] == first
    assert "session/new" not in [m.get("method") for m in sent]
    row = store.get_session(sid)
    assert row["agent_session_id"] == first and row["claude_session_id"] is None


def test_a_non_owner_chat_is_refused(monkeypatch):
    sid = _session(chat=CHAT + 7)
    spawned, real = [], subprocess.Popen
    monkeypatch.setattr(subprocess, "Popen",
                        lambda argv, *a, **kw: spawned.append(argv) or real(argv, *a, **kw))
    job = _start(monkeypatch, sid, {"turn": [CHUNK]}, chat=CHAT + 7)
    assert job.exited.wait(10)
    assert job.status == "error" and "owner" in job.error_msg
    assert store.transcript(sid)["turns"][-1]["status"] == "error"
    assert not any(FAKE in a for a in spawned)
    assert store.get_session(sid)["claude_session_id"] is None


def test_a_claude_model_an_internal_caller_brings_never_reaches_the_agent(monkeypatch):
    """The start-time refusal reads the profile's model; a caller's explicit one
    (Rivendell, goals, the queue) is checked in the turn, before any spawn."""
    sid = _session()
    monkeypatch.setitem(acp_agents.PRESETS[0]["env"], "FAKE_ACP", json.dumps({"turn": [CHUNK]}))
    job = runner.start_streaming_job(CHAT, "hi", [], project=config.BASE_PATH, session_id=sid,
                                     model="claude-opus-5-5")
    assert job.exited.wait(10)
    assert job.status == "error" and "Claude models" in job.error_msg and job.conn is None


def test_a_claude_account_a_caller_brings_never_runs_an_agent_session(monkeypatch):
    sid = _session()
    job = runner.start_streaming_job(CHAT, "hi", [], project=config.BASE_PATH, session_id=sid,
                                     account_slot=1)
    assert job.exited.wait(10)
    assert isinstance(job, runner.AcpJob) and job.status == "error" and job.conn is None
    assert "can't be run on a Claude account" in job.error_msg
    assert store.get_session(sid)["claude_session_id"] is None


def test_a_turn_the_restart_killed_is_left_for_recovery_without_an_error(monkeypatch):
    """As a Claude turn's: no error row, so boot recovery's flip reads INTERRUPTED."""
    sid = _session()
    job = _start(monkeypatch, sid, {"turn": [{"wait_cancel": True}]})
    assert _prompting(job)
    monkeypatch.setattr(state, "shutting_down", True)
    runner.stop_children()
    assert job.exited.wait(10)
    runner._drain_journal()
    assert "error" not in [e["type"] for e in job.events] and "error" not in _journaled(sid)
    assert store.transcript(sid)["turns"][-1]["status"] == "running"
    store.finish_turn(job.id, "error", None, None)        # no orphan for the recovery tests


def test_stop_ends_the_turn_and_releases_the_slot(monkeypatch):
    sid = _session()
    job = _start(monkeypatch, sid, {"turn": [{"wait_cancel": True}], "stop": "cancelled"})
    assert _prompting(job)
    assert runner.get_job(job.id).interrupt()
    assert job.exited.wait(10)
    assert state.acquire_run(sid, CHAT)
    state.release_run(sid)
    assert job.events[-1]["type"] == "stopped"


def test_steer_and_auto_resume_skip_agent_jobs(monkeypatch):
    sid = _session()
    job = _start(monkeypatch, sid, {"turn": [{"wait_cancel": True}], "stop": "cancelled"})
    assert _prompting(job)
    assert runner.steer(sid, "x") is False
    assert job.interrupt() and job.exited.wait(10)
    # Even a row that carries a claude id: an agent turn is never auto-resumed.
    store.set_claude_session_id(sid, "csid-not-this-agents")
    started = []
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **kw: started.append(a))
    dead = runner.AcpJob("j-acp-dead", CHAT, sid)
    dead.runtime, dead.status, dead.error_msg = "acp:fake", "error", "Fake exited"
    assert runner._maybe_auto_resume(dead, config.BASE_PATH, None, None) is False
    assert started == []


def test_the_watchdog_leaves_an_ended_turn_alone():
    """A descendant that setsid'd can hold an agent's stream past the turn's end:
    the watchdog must not then time out, and kill, a turn that is over."""
    class Conn:
        killed = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

    job, conn = runner.AcpJob("j-acp-wd", CHAT), Conn()
    job.hang_timeout = 0.01
    job.exited.set()
    runner._watchdog(job, conn)
    assert not conn.killed and not job.timed_out


def test_stop_children_sweeps_a_live_agent_turns_group(monkeypatch, tmp_path):
    sid = _session()
    job = _start(monkeypatch, sid, {"turn": [{"helper": 30}, {"wait_cancel": True}]})
    pidfile = tmp_path / "log.jsonl.helper"
    assert _wait(lambda: pidfile.exists() and pidfile.read_text())
    runner.stop_children()
    assert job.conn.poll() is not None
    assert _wait(lambda: _gone(int(pidfile.read_text())))
    assert job.exited.wait(10)


def test_awaiting_never_blocks_the_agents_reader(monkeypatch):
    release, seen = threading.Event(), []
    monkeypatch.setattr(runner, "notify_awaiting",
                        lambda *a: (release.wait(5), seen.append(a)))
    job = runner.AcpJob("j-acp-await", CHAT, "s-acp-await")
    t0 = time.time()
    job.awaiting("permission")
    assert time.time() - t0 < 1
    release.set()
    assert _wait(lambda: seen) and seen == [(CHAT, "s-acp-await", "permission")]


def test_the_bot_hands_an_agent_session_back(monkeypatch):
    sid = _session()
    sent = []
    monkeypatch.setattr(runner, "send", lambda chat_id, text, *a, **k: sent.append(text))
    monkeypatch.setattr(runner, "typing", lambda *a, **k: None)
    monkeypatch.setattr(runner, "run_blocking", lambda *a, **k: pytest.fail("ran on claude"))
    assert state.acquire_run(sid, CHAT)                  # what the bot holds before it calls
    runner.handle_task(CHAT, "hi", store.get_session(sid))
    assert sent == [("This session runs on another agent — continue it in the Mini App "
                     "or the dashboard.")]
    assert store.count_turns(sid) == 0
    assert state.acquire_run(sid, CHAT)                  # released on the way out
    state.release_run(sid)


def _handler(mod):
    h, box = mod.Handler.__new__(mod.Handler), {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


@pytest.mark.parametrize("mod", [dash, mini])
def test_run_and_picks_are_checked_against_the_sessions_agent(mod, monkeypatch):
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)
    sid = _session()
    started = []
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **kw: started.append(kw))
    h, box = _handler(mod)
    run = h._run if mod is dash else h._api_run
    run(CHAT, {"prompt": "hi", "session_id": sid, "model": "claude-opus-5-5"})
    assert box["code"] == 400 and "Claude models" in box["obj"]["error"] and not started
    run(CHAT, {"prompt": "hi", "session_id": sid, "model": "gpt-5.1",
               "permission_mode": "read-only"})
    assert (started[-1]["model"], started[-1]["permission_mode"]) == ("gpt-5.1", "read-only")
    code = mini.save_run_settings(store.get_session(sid), {"model": "gpt-5.1", "pick": "model"})[1]
    assert code == 200 and store.get_session(sid)["model"] == "gpt-5.1"
    assert mini.save_run_settings(store.get_session(sid), {"model": "claude-opus-5-5"})[1] == 400


def test_dashboard_run_refuses_a_claude_account_on_an_agent_session(monkeypatch):
    from bridge import accounts
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)
    monkeypatch.setattr(accounts, "list_accounts", lambda: [{"slot": 1, "disabled": False}])
    started = []
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **kw: started.append(kw))
    h, box = _handler(dash)
    h._run(CHAT, {"prompt": "hi", "session_id": _session(), "agent": "claude:1"})
    assert box["code"] == 400 and not started
    assert box["obj"]["error"] == "This session runs on Fake; it can't be run on a Claude account."


# Final review I-1: a key account signs in with ACP `authenticate`, in its own home.

KEY = "sk-fake-abcdefghijklmnop"
AUTH = {"auth_required": True, "auth_methods": [{"id": "api-key", "name": "API Key"}],
        "turn": [CHUNK]}


def _keyed(monkeypatch, kind="key"):
    monkeypatch.setitem(acp_agents.PRESETS[0], "key_env", "OPENAI_API_KEY")
    monkeypatch.setitem(acp_agents.PRESETS[0], "home_env", "CODEX_HOME")
    monkeypatch.setitem(acp_agents.PRESETS[0], "auth_method", "api-key")
    a = acp_agents.add_account("fake", "k", kind, key=KEY if kind == "key" else None)
    p = profiles.create({"name": f"Keyed {kind}", "agent": "fake", "account": a["id"]})
    return store.create_session(CHAT, "/acp-run", cwd=config.BASE_PATH, profile_id=p["id"])["id"]


def _log(tmp_path, suffix=""):
    return tmp_path / f"log.jsonl{suffix}"


def test_a_key_account_turn_authenticates_in_its_own_home(monkeypatch, tmp_path):
    sid = _keyed(monkeypatch)
    job = _start(monkeypatch, sid, AUTH)
    assert job.exited.wait(10)
    assert job.status == "done", job.error_msg
    sent = [json.loads(line) for line in _log(tmp_path).read_text().splitlines()]
    auth = [m for m in sent if m.get("method") == "authenticate"]
    assert auth and auth[0]["params"] == {"methodId": "api-key"}
    env = json.loads(_log(tmp_path, ".env").read_text())
    assert env["OPENAI_API_KEY"] == KEY
    home = env["CODEX_HOME"]
    assert os.path.commonpath([home, acp_agents.HOMES]) == acp_agents.HOMES
    assert home != os.path.expanduser("~/.codex")


def test_a_separate_login_is_never_authenticated_with_a_key(monkeypatch, tmp_path):
    sid = _keyed(monkeypatch, kind="home")
    job = _start(monkeypatch, sid, AUTH)
    assert job.exited.wait(10)
    assert job.status == "error" and "needs a login" in job.error_msg
    sent = [json.loads(line) for line in _log(tmp_path).read_text().splitlines()]
    assert "authenticate" not in [m.get("method") for m in sent]
