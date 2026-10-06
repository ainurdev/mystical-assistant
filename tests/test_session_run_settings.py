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
