"""SQLite-backed session store: the single source of truth for Claude
conversations (sessions -> turns -> events).

Stdlib only. One short-lived connection per operation (WAL + busy_timeout), so
it is safe to call from the bridge's many threads and both HTTP servers without a
shared-connection race. Multi-statement writes use an explicit BEGIN IMMEDIATE so
event sequence allocation is atomic. See
docs/superpowers/specs/2026-06-23-unified-sessions-dashboard-design.md
"""

import json
import os
import sqlite3
import time
import uuid
from contextlib import closing

from bridge import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  chat_id           INTEGER NOT NULL,
  project           TEXT NOT NULL,
  claude_session_id TEXT,
  title             TEXT,
  created           REAL NOT NULL,
  updated           REAL NOT NULL,
  archived          INTEGER NOT NULL DEFAULT 0,
  origin            TEXT,
  cwd               TEXT,
  permission_mode   TEXT,
  title_source      TEXT DEFAULT 'auto',
  fallback_policy   TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_proj
  ON sessions(chat_id, project, archived, updated);

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  prompt      TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL,
  cost        REAL,
  elapsed     INTEGER,
  started     REAL NOT NULL,
  model       TEXT,
  runtime     TEXT
);
CREATE INDEX IF NOT EXISTS ix_turns_session ON turns(session_id, seq);
CREATE INDEX IF NOT EXISTS ix_turns_status ON turns(status);
CREATE INDEX IF NOT EXISTS ix_sessions_csid ON sessions(claude_session_id);

CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  ts          REAL NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  owner_id          INTEGER NOT NULL,
  scope             TEXT NOT NULL,          -- 'user' | 'project'
  project_path      TEXT,                   -- NULL when scope='user'
  branch            TEXT,                   -- NULL = project-wide / user scope
  type              TEXT NOT NULL,          -- convention|decision|preference|goal|gotcha
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  status            TEXT NOT NULL,          -- candidate|active|archived
  pinned            INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT,
  source_turn_id    TEXT,
  supersedes_id     TEXT,                   -- UPDATE candidate: the memory it replaces on Keep
  embedding         BLOB,                   -- reserved for sqlite-vec (Approach B)
  use_count         INTEGER NOT NULL DEFAULT 0,
  created_at        REAL NOT NULL,
  updated_at        REAL NOT NULL,
  last_used_at      REAL
);
CREATE INDEX IF NOT EXISTS ix_memories_ns
  ON memories(owner_id, scope, project_path, branch, status);

CREATE TABLE IF NOT EXISTS learning_items (
  id               TEXT PRIMARY KEY,
  owner_id         INTEGER NOT NULL,
  project_path     TEXT NOT NULL,
  session_id       TEXT,
  source_turn_id   TEXT,
  title            TEXT NOT NULL,
  code_snippet     TEXT NOT NULL DEFAULT '',
  why_it_matters   TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'candidate',
  mastery          INTEGER NOT NULL DEFAULT 0,
  times_reviewed   INTEGER NOT NULL DEFAULT 0,
  created_at       REAL NOT NULL,
  last_reviewed_at REAL,
  notes            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_learning_owner
  ON learning_items(owner_id, project_path, status, created_at);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.BRIDGE_DB, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None  # autocommit; manage transactions explicitly
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init() -> None:
    """Create the DB dir (0700), tables, and lock down file perms. Idempotent."""
    path = config.BRIDGE_DB
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, mode=0o700, exist_ok=True)
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
    with closing(_connect()) as c:
        c.executescript(_SCHEMA)
        # Migration for DBs created before turns.model existed (idempotent).
        cols = {r["name"] for r in c.execute("PRAGMA table_info(turns)").fetchall()}
        if "model" not in cols:
            c.execute("ALTER TABLE turns ADD COLUMN model TEXT")
        # Cross-surface continuity columns (idempotent; old DBs predate them).
        scols = {r["name"] for r in c.execute("PRAGMA table_info(sessions)").fetchall()}
        for col in ("origin", "cwd", "permission_mode"):
            if col not in scols:
                c.execute(f"ALTER TABLE sessions ADD COLUMN {col} TEXT")
        # Title provenance: 'auto' (first-prompt), 'subject' (LLM), 'manual'.
        if "title_source" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN title_source TEXT DEFAULT 'auto'")
        # Fallback ladder: what to do when a turn dies on a usage limit
        # ('ask' | 'auto' | 'wait'; NULL = the configured default).
        if "fallback_policy" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN fallback_policy TEXT")
        # Which runtime produced a turn (NULL = the default Claude account,
        # else 'claude:<slot>' or 'opencode:<provider>').
        if "runtime" not in cols:
            c.execute("ALTER TABLE turns ADD COLUMN runtime TEXT")
        # (Old DBs may carry a dead last_auto_resume column from the retired
        # auto-resume cooldown — harmless, never read.)
        # Turns left 'running' at startup are orphaned (the bridge restarted). They
        # are claimed — flipped to 'error' AND returned for auto-resume — by
        # claim_orphaned_turns(), which the startup recovery step calls.
    for suffix in ("", "-wal", "-shm"):
        p = path + suffix
        if os.path.exists(p):
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass


def _row(r) -> dict | None:
    return dict(r) if r is not None else None


# --- sessions ---------------------------------------------------------------

def create_session(chat_id: int, project: str, *, session_id: str | None = None,
                   origin: str | None = None, cwd: str | None = None,
                   permission_mode: str | None = None) -> dict:
    sid = session_id or uuid.uuid4().hex
    now = time.time()
    with closing(_connect()) as c:
        c.execute(
            "INSERT INTO sessions(id,chat_id,project,claude_session_id,title,"
            "created,updated,archived,origin,cwd,permission_mode) "
            "VALUES(?,?,?,?,?,?,?,0,?,?,?)",
            (sid, chat_id, project, None, None, now, now, origin, cwd, permission_mode))
    return get_session(sid)


def get_session(session_id: str) -> dict | None:
    with closing(_connect()) as c:
        return _row(c.execute("SELECT * FROM sessions WHERE id=?",
                              (session_id,)).fetchone())


def get_by_claude_session_id(claude_sid: str) -> dict | None:
    """Reverse lookup: the bridge session row carrying this Claude native UUID.
    The join from Claude's world back into ours (drives native-session dedup)."""
    with closing(_connect()) as c:
        return _row(c.execute(
            "SELECT * FROM sessions WHERE claude_session_id=? ORDER BY updated DESC LIMIT 1",
            (claude_sid,)).fetchone())


def upsert_native_session(claude_sid: str, chat_id: int, project: str, cwd: str, *,
                          title: str | None = None, updated: float | None = None,
                          origin: str = "vscode") -> dict:
    """Index a native (VSCode/terminal) Claude session by its UUID so it appears in
    the unified list and is resumable. The row id IS the native UUID. Dedups on
    claude_session_id: on re-scan it refreshes `updated` (monotonically) and
    backfills `cwd`, but preserves an existing title and origin — so a bridge-run
    session whose JSONL the scanner re-encounters is not reclassified."""
    now = updated if updated is not None else time.time()
    existing = get_by_claude_session_id(claude_sid)
    with closing(_connect()) as c:
        if existing:
            # Refresh mtime/cwd; keep an existing human title but heal auto-titles
            # that captured a leading system tag (e.g. <ide_opened_file>…).
            c.execute(
                "UPDATE sessions SET updated=MAX(updated, ?), cwd=COALESCE(cwd, ?), "
                "title=CASE WHEN title IS NULL OR title='' OR title LIKE '<%' "
                "THEN ? ELSE title END WHERE id=?",
                (now, cwd, title, existing["id"]))
            return get_session(existing["id"])
        c.execute(
            "INSERT INTO sessions(id,chat_id,project,claude_session_id,title,"
            "created,updated,archived,origin,cwd,permission_mode) "
            "VALUES(?,?,?,?,?,?,?,0,?,?,?)",
            (claude_sid, chat_id, project, claude_sid, title, now, now, origin, cwd, None))
    return get_session(claude_sid)


# Sessions whose last message is older than this drop off the shared lists
# (sidebar + history) across every surface. Resuming/viewing a session by id is
# unaffected — the full transcript is always preserved.
LIST_MAX_AGE_SECS = 30 * 86400


def list_sessions(chat_id: int, project: str, include_archived: bool = False,
                  max_age_secs: float | None = LIST_MAX_AGE_SECS) -> list[dict]:
    q = "SELECT * FROM sessions WHERE chat_id=? AND project=?"
    params: list = [chat_id, project]
    if not include_archived:
        q += " AND archived=0"
    if max_age_secs is not None:
        q += " AND updated >= ?"
        params.append(time.time() - max_age_secs)
    q += " ORDER BY updated DESC"
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(q, params).fetchall()]


def latest_session(chat_id: int, project: str) -> dict | None:
    # Unfiltered: resuming a project must find its latest session even if idle.
    rows = list_sessions(chat_id, project, max_age_secs=None)
    return rows[0] if rows else None


def list_sessions_all(chat_id: int, include_archived: bool = False,
                      max_age_secs: float | None = LIST_MAX_AGE_SECS) -> list[dict]:
    """Every session for a chat across all projects (dashboard sidebar tree)."""
    q = "SELECT * FROM sessions WHERE chat_id=?"
    params: list = [chat_id]
    if not include_archived:
        q += " AND archived=0"
    if max_age_secs is not None:
        q += " AND updated >= ?"
        params.append(time.time() - max_age_secs)
    q += " ORDER BY project, updated DESC"
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(q, params).fetchall()]


def resolve_session(chat_id: int, project: str,
                    session_id: str | None = None) -> dict | None:
    """The non-creating half of ensure_session: a valid given id for this chat,
    else the latest for the project, else None. Lets a caller see which session a
    run WOULD resume without creating one (the relevance guardrail)."""
    if session_id:
        s = get_session(session_id)
        if s and s["chat_id"] == chat_id:
            return s
    return latest_session(chat_id, project)


def ensure_session(chat_id: int, project: str, session_id: str | None = None, *,
                   origin: str | None = None, cwd: str | None = None,
                   permission_mode: str | None = None) -> dict:
    """Resolve a session: a valid given id for this chat, else the latest for the
    project, else a fresh one. The origin/cwd/permission_mode are applied ONLY
    when a new session is created (resuming an existing one leaves it untouched)."""
    return resolve_session(chat_id, project, session_id) or create_session(
        chat_id, project, origin=origin, cwd=cwd, permission_mode=permission_mode)


def set_claude_session_id(session_id: str, claude_sid: str | None) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET claude_session_id=?, updated=? WHERE id=?",
                  (claude_sid, time.time(), session_id))


def set_permission_mode(session_id: str, mode: str | None) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET permission_mode=? WHERE id=?", (mode, session_id))


def set_fallback_policy(session_id: str, policy: str | None) -> None:
    """What to do when this session's turn dies on a usage limit; None = the
    configured default. Validated by ladder.policy_for, not here."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET fallback_policy=? WHERE id=?",
                  (policy, session_id))


def set_cwd(session_id: str, cwd: str | None) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET cwd=? WHERE id=?", (cwd, session_id))


def set_origin(session_id: str, origin: str | None) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET origin=? WHERE id=?", (origin, session_id))


def set_subject_title(session_id: str, title: str) -> None:
    """Replace an auto (first-prompt) title with an LLM-generated subject, marking
    it 'subject'. No-op once the title is already a subject or a manual rename — so
    we never regenerate and never clobber a name the user chose."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET title=?, title_source='subject' "
                  "WHERE id=? AND title_source='auto'", (title, session_id))


# --- learning items ---------------------------------------------------------

def add_learning_item(owner_id: int, project_path: str, title: str, *,
                      session_id: str | None = None, source_turn_id: str | None = None,
                      code_snippet: str = "", why_it_matters: str = "",
                      status: str = "candidate") -> dict:
    iid = uuid.uuid4().hex
    now = time.time()
    with closing(_connect()) as c:
        c.execute(
            "INSERT INTO learning_items(id,owner_id,project_path,session_id,"
            "source_turn_id,title,code_snippet,why_it_matters,status,mastery,"
            "times_reviewed,created_at,last_reviewed_at,notes) "
            "VALUES(?,?,?,?,?,?,?,?,?,0,0,?,NULL,'')",
            (iid, owner_id, project_path, session_id, source_turn_id, title,
             code_snippet, why_it_matters, status, now))
    return get_learning_item(iid)


def get_learning_item(item_id: str) -> dict | None:
    with closing(_connect()) as c:
        return _row(c.execute("SELECT * FROM learning_items WHERE id=?",
                              (item_id,)).fetchone())


def list_learning_items(owner_id: int, project_path: str | None = None,
                        status: str = "kept") -> list[dict]:
    q = "SELECT * FROM learning_items WHERE owner_id=? AND status=?"
    params: list = [owner_id, status]
    if project_path is not None:
        q += " AND project_path=?"
        params.append(project_path)
    q += " ORDER BY created_at DESC"
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(q, params).fetchall()]


def set_learning_status(item_id: str, status: str) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE learning_items SET status=? WHERE id=?", (status, item_id))


def bump_mastery(item_id: str) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE learning_items SET mastery=mastery+1,"
                  "times_reviewed=times_reviewed+1,last_reviewed_at=? WHERE id=?",
                  (time.time(), item_id))


def append_learning_note(item_id: str, text: str) -> None:
    if not text:
        return
    with closing(_connect()) as c:
        c.execute("UPDATE learning_items SET notes=notes||? WHERE id=?",
                  ("\n" + text, item_id))


def rename(session_id: str, title: str) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET title=?, title_source='manual' WHERE id=?",
                  (title, session_id))


def archive(session_id: str, archived: bool = True) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET archived=?, updated=? WHERE id=?",
                  (1 if archived else 0, time.time(), session_id))


# --- turns + events ---------------------------------------------------------

def recent_prompts(session_id: str, limit: int) -> list[str]:
    """The session's most recent user prompts, newest first. Empty when it has no
    turns yet — which is also how callers ask "does this session have history?"."""
    with closing(_connect()) as c:
        rows = c.execute("SELECT prompt FROM turns WHERE session_id=? "
                         "ORDER BY seq DESC LIMIT ?", (session_id, limit)).fetchall()
    return [r["prompt"] or "" for r in rows]


def start_turn(session_id: str, turn_id: str, prompt: str,
               attachments: list[str] | None, model: str | None = None,
               runtime: str | None = None) -> None:
    now = time.time()
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        seq = c.execute("SELECT COALESCE(MAX(seq),-1)+1 AS n FROM turns WHERE session_id=?",
                        (session_id,)).fetchone()["n"]
        c.execute(
            "INSERT INTO turns(id,session_id,seq,prompt,attachments,status,cost,"
            "elapsed,started,model,runtime) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (turn_id, session_id, seq, prompt, json.dumps(attachments or []),
             "running", None, None, now, model, runtime))
        c.execute("UPDATE sessions SET updated=? WHERE id=?", (now, session_id))
        cur = c.execute("SELECT title FROM sessions WHERE id=?", (session_id,)).fetchone()
        if cur is not None and not cur["title"]:
            c.execute("UPDATE sessions SET title=?, title_source='auto' WHERE id=?",
                      (prompt.strip()[:60] or "New chat", session_id))
        c.execute("COMMIT")


def append_event(session_id: str, turn_id: str, ev: dict) -> int:
    """Append one compact event; returns its session-level seq (atomic)."""
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        seq = c.execute("SELECT COALESCE(MAX(seq),-1)+1 AS n FROM events WHERE session_id=?",
                        (session_id,)).fetchone()["n"]
        c.execute("INSERT INTO events(session_id,turn_id,seq,type,payload,ts) "
                  "VALUES(?,?,?,?,?,?)",
                  (session_id, turn_id, seq, ev.get("type", ""), json.dumps(ev), time.time()))
        c.execute("COMMIT")
    return seq


def finish_turn(turn_id: str, status: str, cost: float | None, elapsed: int | None) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE turns SET status=?, cost=?, elapsed=? WHERE id=?",
                  (status, cost, elapsed, turn_id))


def import_transcript(session_id: str, turns: list[dict], events: list[dict]) -> bool:
    """Bulk-load a translated transcript (turns + events) into the store. Used to
    ADOPT a native session on its first bridge continuation, so its full prior
    history renders from the store alongside new turns. Idempotent: a no-op (and
    returns False) if the session already has turns."""
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        have = c.execute("SELECT COUNT(*) n FROM turns WHERE session_id=?",
                         (session_id,)).fetchone()["n"]
        if have:
            c.execute("COMMIT")
            return False
        for t in turns:
            c.execute(
                "INSERT INTO turns(id,session_id,seq,prompt,attachments,status,cost,"
                "elapsed,started,model) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (t["id"], session_id, t["seq"], t.get("prompt", ""),
                 json.dumps(t.get("attachments") or []), t.get("status", "done"),
                 t.get("cost"), t.get("elapsed"), t.get("started") or time.time(),
                 t.get("model")))
        for e in events:
            payload = {k: v for k, v in e.items() if k not in ("seq", "turn_id")}
            c.execute("INSERT INTO events(session_id,turn_id,seq,type,payload,ts) "
                      "VALUES(?,?,?,?,?,?)",
                      (session_id, e["turn_id"], e["seq"], e.get("type", ""),
                       json.dumps(payload), e.get("ts") or time.time()))
        c.execute("COMMIT")
    return True


def history(chat_id: int, include_archived: bool = False,
            max_age_secs: float | None = LIST_MAX_AGE_SECS) -> list[dict]:
    """Per-repo session rollup: one row per session with aggregates joined from
    its turns — turn_count, total_cost, last_activity, and distinct models used.
    Newest activity first."""
    q = ("SELECT s.id, s.title, s.project, s.origin, s.created, s.updated, s.archived, "
         "COUNT(t.id) AS turn_count, "
         "COALESCE(SUM(t.cost), 0) AS total_cost, "
         "COALESCE(MAX(t.started), s.updated) AS last_activity, "
         "GROUP_CONCAT(DISTINCT t.model) AS models "
         "FROM sessions s LEFT JOIN turns t ON t.session_id = s.id "
         "WHERE s.chat_id=?")
    params: list = [chat_id]
    if not include_archived:
        q += " AND s.archived=0"
    if max_age_secs is not None:
        q += " AND s.updated >= ?"
        params.append(time.time() - max_age_secs)
    q += " GROUP BY s.id ORDER BY last_activity DESC"
    rows = []
    with closing(_connect()) as c:
        for r in c.execute(q, params).fetchall():
            d = dict(r)
            d["models"] = sorted(m for m in (d.pop("models") or "").split(",") if m)
            rows.append(d)
    return rows


def running_session_ids(chat_id: int) -> list[str]:
    """Session ids (for this chat) with an in-flight turn — drives the dashboard's
    'running' badge. A running turn means a live bridge job (orphans are reset to
    'error' on startup, and the per-session run lock forbids two turns on one
    session)."""
    with closing(_connect()) as c:
        rows = c.execute(
            "SELECT DISTINCT t.session_id FROM turns t "
            "JOIN sessions s ON s.id=t.session_id "
            "WHERE s.chat_id=? AND t.status='running'", (chat_id,)).fetchall()
    return [r["session_id"] for r in rows]


def claim_orphaned_turns() -> list[dict]:
    """Turns left 'running' at startup were orphaned by a restart (the bridge
    group-SIGKILLs its Claude child on stop). Atomically flip them to 'error' and
    return them joined to their session, so the recovery step can resume each on
    its own Claude session. Idempotent: a second call returns []."""
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        rows = c.execute(
            "SELECT t.id AS turn_id, t.session_id, t.prompt, t.model, "
            "s.chat_id, s.cwd, s.project, s.claude_session_id "
            "FROM turns t JOIN sessions s ON s.id=t.session_id "
            "WHERE t.status='running'").fetchall()
        c.execute("UPDATE turns SET status='error' WHERE status='running'")
        c.execute("COMMIT")
    return [dict(r) for r in rows]


def transcript(session_id: str, cursor: int = 0) -> dict:
    """Session + its turns + events with seq >= cursor. `next_cursor` is the seq
    to pass next time to get only newer events."""
    with closing(_connect()) as c:
        s = _row(c.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone())
        turns = [dict(r) for r in c.execute(
            "SELECT * FROM turns WHERE session_id=? ORDER BY seq", (session_id,)).fetchall()]
        evrows = c.execute(
            "SELECT seq,turn_id,payload FROM events WHERE session_id=? AND seq>=? ORDER BY seq",
            (session_id, cursor)).fetchall()
    events = []
    for r in evrows:
        d = json.loads(r["payload"])
        d["seq"] = r["seq"]
        d["turn_id"] = r["turn_id"]
        events.append(d)
    for t in turns:
        t["attachments"] = json.loads(t["attachments"])
    next_cursor = (events[-1]["seq"] + 1) if events else cursor
    return {"session": s, "turns": turns, "events": events, "next_cursor": next_cursor}


# --- memories (project memory) ----------------------------------------------
# Curated, project+branch-scoped semantic memory. See
# docs/superpowers/specs/2026-07-01-project-memory-design.md

def add_memory(owner_id: int, scope: str, type: str, title: str, body: str, *,
               project_path: str | None = None, branch: str | None = None,
               status: str = "candidate", pinned: bool = False,
               source_session_id: str | None = None, source_turn_id: str | None = None,
               supersedes_id: str | None = None) -> dict:
    mid = uuid.uuid4().hex
    now = time.time()
    with closing(_connect()) as c:
        c.execute(
            "INSERT INTO memories(id,owner_id,scope,project_path,branch,type,title,body,"
            "status,pinned,source_session_id,source_turn_id,supersedes_id,use_count,"
            "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
            (mid, owner_id, scope, project_path, branch, type, title, body, status,
             1 if pinned else 0, source_session_id, source_turn_id, supersedes_id, now, now))
    return get_memory(mid)


def get_memory(mem_id: str) -> dict | None:
    with closing(_connect()) as c:
        return _row(c.execute("SELECT * FROM memories WHERE id=?", (mem_id,)).fetchone())


def list_memories(owner_id: int, *, scope: str | None = None, project: str | None = None,
                  branch: str | None = None, status: str | None = None,
                  type: str | None = None) -> list[dict]:
    """General filter for the Memory view: exact-match on any provided field."""
    q = "SELECT * FROM memories WHERE owner_id=?"
    params: list = [owner_id]
    for col, val in (("scope", scope), ("project_path", project), ("branch", branch),
                     ("status", status), ("type", type)):
        if val is not None:
            q += f" AND {col}=?"
            params.append(val)
    q += " ORDER BY pinned DESC, created_at DESC"
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(q, params).fetchall()]


def set_memory_status(mem_id: str, status: str) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE memories SET status=?, updated_at=? WHERE id=?",
                  (status, time.time(), mem_id))


def set_pinned(mem_id: str, pinned: bool) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE memories SET pinned=?, updated_at=? WHERE id=?",
                  (1 if pinned else 0, time.time(), mem_id))


def update_memory(mem_id: str, title: str | None = None, body: str | None = None) -> None:
    sets, params = [], []
    if title is not None:
        sets.append("title=?"); params.append(title)
    if body is not None:
        sets.append("body=?"); params.append(body)
    if not sets:
        return
    sets.append("updated_at=?"); params.append(time.time())
    params.append(mem_id)
    with closing(_connect()) as c:
        c.execute(f"UPDATE memories SET {', '.join(sets)} WHERE id=?", params)


def touch_memory(mem_id: str) -> None:
    """Record that a memory was injected/used. Deliberately does NOT bump
    updated_at, so the resident pack stays byte-stable across turns (caching)."""
    with closing(_connect()) as c:
        c.execute("UPDATE memories SET use_count=use_count+1, last_used_at=? WHERE id=?",
                  (time.time(), mem_id))


def supersede_memory(old_id: str, title: str | None = None,
                     body: str | None = None) -> dict | None:
    """Archive `old_id` and add an active replacement in the same namespace/type,
    with new title/body (falling back to the old values). Returns the new row."""
    old = get_memory(old_id)
    if old is None:
        return None
    set_memory_status(old_id, "archived")
    return add_memory(
        old["owner_id"], old["scope"], old["type"],
        old["title"] if title is None else title,
        old["body"] if body is None else body,
        project_path=old["project_path"], branch=old["branch"],
        status="active", pinned=bool(old["pinned"]), supersedes_id=old_id)


# The active cascade for a session: user prefs + project-wide facts + this branch.
# A NULL branch arg matches only project-wide rows (branch IS NULL).
_CASCADE = ("(scope='user' OR (scope='project' AND project_path=? "
            "AND (branch IS NULL OR branch=?)))")


def resolve_memories(owner_id: int, project: str, branch: str | None) -> list[dict]:
    """Active memories a session should see, pinned-first then newest."""
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(
            f"SELECT * FROM memories WHERE owner_id=? AND status='active' AND {_CASCADE} "
            "ORDER BY pinned DESC, created_at DESC",
            (owner_id, project, branch)).fetchall()]


def namespace_version(owner_id: int, project: str, branch: str | None) -> float:
    """max(updated_at) over the active cascade — the Context Pack's memoization key.
    Changes iff the resident pack would change; 0.0 when the cascade is empty."""
    with closing(_connect()) as c:
        return c.execute(
            f"SELECT COALESCE(MAX(updated_at), 0.0) AS v FROM memories "
            f"WHERE owner_id=? AND status='active' AND {_CASCADE}",
            (owner_id, project, branch)).fetchone()["v"]
