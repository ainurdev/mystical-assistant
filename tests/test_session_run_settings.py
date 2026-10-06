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
