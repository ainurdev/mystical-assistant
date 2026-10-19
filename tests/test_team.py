"""bridge/team.py: teammates' presence, and sessions, pictures and files sent to them
through Rivendell. What a teammate sends is rebuilt from a whitelist and stays read
only until CONTINUE HERE makes it your own.
Run: python -m pytest tests/test_team.py -q"""

import subprocess
import threading
import time

import pytest

from bridge import config, device_view, relevance, runner, store, team

store.init()
CHAT = config.DASH_CHAT_ID


# --- read only ------------------------------------------------------------------------------------

def test_refusal_names_both_kinds_of_someone_elses_session():
    assert team.refusal("device-run:prod") == device_view.REFUSAL
    assert team.refusal("team:prod") == team.REFUSAL
    for mine in (None, "", "dashboard", "telegram", "rivendell:prod", "teammate"):
        assert team.refusal(mine) is None, mine


def test_a_team_session_is_never_a_projects_latest_session():
    chat = 777_101
    mine = store.create_session(chat, "/")
    store.create_session(chat, "/", origin="team:prod")      # newer
    assert store.latest_session(chat, "/")["id"] == mine["id"]
    assert store.ensure_session(chat, "/")["id"] == mine["id"]


def test_a_team_sessions_running_turn_is_never_resumed():
    sid = store.create_session(CHAT, "/", origin="team:prod")["id"]
    store.start_turn(sid, sid, "their prompt", None)
    assert sid not in {r["session_id"] for r in store.claim_orphaned_turns()}


def test_no_relevance_check_reads_a_team_session(monkeypatch):
    monkeypatch.setattr(config, "RELEVANCE_CHECK", True)
    long = "x" * (config.RELEVANCE_MIN_CHARS + 1)
    for origin, expect in (("dashboard", True), ("team:prod", False)):
        sid = store.create_session(CHAT, "/", origin=origin)["id"]
        store.start_turn(sid, uuid_hex(), "an earlier prompt", None)
        assert relevance.should_check(store.get_session(sid), long) is expect, origin


def test_runs_are_refused_on_team_sessions(monkeypatch):
    from bridge import learn, tailstate, titler
    for mod in (titler, learn, tailstate):                            # no model calls
        monkeypatch.setattr(mod, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_ensure_journal_thread", lambda: None)

    def no_claude(*a, **k):
        raise AssertionError("built a claude argv for a teammate's session")
    monkeypatch.setattr(runner, "_base_cmd", no_claude)
    spawned, real = [], subprocess.Popen
    monkeypatch.setattr(subprocess, "Popen", lambda argv, *a, **k: spawned.append(argv) or real(argv, *a, **k))
    sid = store.create_session(CHAT, "/", origin="team:prod", cwd=config.BASE_PATH)["id"]
    job = runner.start_streaming_job(CHAT, "keep going", [], project=config.BASE_PATH, session_id=sid,
                                     account_slot=2)
    assert job.exited.wait(10)
    end = time.time() + 10
    while time.time() < end and any("_run_streaming" in t.name for t in threading.enumerate()):
        time.sleep(0.02)
    runner._drain_journal()
    assert job.refusal == team.REFUSAL
    assert (job.status, job.resume_id, job.account_slot) == ("error", None, None)
    assert not any("claude" in " ".join(map(str, a if isinstance(a, list) else [a])) for a in spawned)
    row = store.get_session(sid)
    assert row["claude_session_id"] is None and row["profile_id"] is None


def test_a_team_session_carries_its_facts_to_the_dashboard():
    from bridge.miniapp import server as mini
    sid = store.create_session(CHAT, "/", origin="team:prod")["id"]
    facts = {"share": "s-1", "instance": "prod", "kind": "session", "from": {"id": "u-2", "name": "Erfan"},
             "note": "can you take it from here?", "sent": "2026-10-19T20:00:00Z", "meta": {"turns": 1}}
    store.set_team(sid, facts)
    assert mini._session_brief(store.get_session(sid))["team"] == facts
    other = store.create_session(CHAT, "/")["id"]
    assert mini._session_brief(store.get_session(other))["team"] is None


def uuid_hex():
    import uuid
    return uuid.uuid4().hex
