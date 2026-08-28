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
import secrets
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
  fallback_policy   TEXT,
  goal              TEXT,
  lifecycle         TEXT,
  fork_from         TEXT,
  ctx_tokens        INTEGER,
  autocompact       TEXT
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
  runtime     TEXT,
  sha         TEXT,
  tok_in      INTEGER,
  tok_out     INTEGER,
  tok_cache_w INTEGER,
  tok_cache_r INTEGER
);
CREATE INDEX IF NOT EXISTS ix_turns_session ON turns(session_id, seq);
CREATE INDEX IF NOT EXISTS ix_turns_status ON turns(status);
CREATE INDEX IF NOT EXISTS ix_sessions_csid ON sessions(claude_session_id);

CREATE TABLE IF NOT EXISTS shares (
  token       TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  created     REAL NOT NULL,
  expires     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_shares_session ON shares(session_id);

CREATE TABLE IF NOT EXISTS hooks (
  token     TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  source    TEXT NOT NULL,
  secret    TEXT,
  created   REAL NOT NULL,
  last_seen REAL,
  hits      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hook_events (
  id       TEXT PRIMARY KEY,
  token    TEXT NOT NULL,
  source   TEXT NOT NULL,
  title    TEXT,
  url      TEXT,
  payload  TEXT NOT NULL,
  received REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_hook_events_recv ON hook_events(received);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  ts          REAL NOT NULL,
  PRIMARY KEY (session_id, seq)
);

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
        # Active goal as JSON {objective, state, iter}; NULL = no goal. One column
        # because the three fields are only ever read and written together.
        if "goal" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN goal TEXT")
        # Why a session is hidden: done | abandoned | backlog (NULL = active).
        # Old rows carry archived=1 with no reason — backfill them as 'done'.
        if "lifecycle" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN lifecycle TEXT")
            c.execute("UPDATE sessions SET lifecycle='done' WHERE archived=1")
        # A duplicated session carries its source's claude session id here instead
        # of in claude_session_id: its first run resumes that transcript with
        # --fork-session, so claude mints a fresh id and the original is never
        # written to. Cleared the moment a real id lands.
        if "fork_from" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN fork_from TEXT")
        # Tools/MCP servers switched off for this session, as a JSON array of
        # claude deny rules ("Bash", "mcp__playwright"). NULL/[] = everything on.
        if "disabled_tools" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN disabled_tools TEXT")
        # How full the context window was at the end of the last turn, so the
        # meter has a number before anything runs. NULL = never measured.
        if "ctx_tokens" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN ctx_tokens INTEGER")
        # Window size at which claude auto-compacts this session ('auto' or a
        # token count); NULL = don't pass --autocompact, i.e. the CLI default.
        if "autocompact" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN autocompact TEXT")
        # Where the session's shell actually is, when it has walked out of `cwd`
        # into one of the repo's worktrees (runner._note_work_cwd). NULL = it is
        # working in its own checkout, which is the normal case.
        if "work_cwd" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN work_cwd TEXT")
        # Which runtime produced a turn (NULL = the default Claude account,
        # else 'claude:<slot>' or 'opencode:<provider>').
        if "runtime" not in cols:
            c.execute("ALTER TABLE turns ADD COLUMN runtime TEXT")
        # Commit HEAD pointed at when the turn started, so a checkpoint can show
        # what the tree has drifted since. NULL = not a repo / predates this.
        if "sha" not in cols:
            c.execute("ALTER TABLE turns ADD COLUMN sha TEXT")
        # What this turn spent, in the only unit that is real on a subscription:
        # tokens. The four the API reports, summed across the turn's messages —
        # which is spend, as distinct from sessions.ctx_tokens, which is the last
        # message's window fill. NULL = the turn predates this / never reported.
        for col in ("tok_in", "tok_out", "tok_cache_w", "tok_cache_r"):
            if col not in cols:
                c.execute(f"ALTER TABLE turns ADD COLUMN {col} INTEGER")
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
            (sid, chat_id, project, None, None, now, now, origin, cwd,
             permission_mode))
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
    backfills `cwd`, but preserves an existing title — and only ever rewrites an
    origin that is itself native, so a bridge-run session whose JSONL the scanner
    re-encounters is not reclassified."""
    now = updated if updated is not None else time.time()
    existing = get_by_claude_session_id(claude_sid)
    with closing(_connect()) as c:
        if existing:
            # Refresh mtime/cwd; keep an existing human title but heal auto-titles
            # that captured a leading system tag (e.g. <ide_opened_file>…).
            # Origin heals within the native pair only, so rows indexed before the
            # scanner could tell VS Code from terminal pick up their real surface.
            c.execute(
                "UPDATE sessions SET updated=MAX(updated, ?), cwd=COALESCE(cwd, ?), "
                "title=CASE WHEN title IS NULL OR title='' OR title LIKE '<%' "
                "THEN ? ELSE title END, "
                "origin=CASE WHEN origin IN ('vscode','terminal') THEN ? ELSE origin END "
                "WHERE id=?",
                (now, cwd, title, origin, existing["id"]))
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
    """Link a store row to its claude session. Clears fork_from: once a forked
    copy has its own id, the pending fork is spent, and leaving it set would make
    every later run re-fork off the original."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET claude_session_id=?, updated=?, "
                  "fork_from=NULL WHERE id=?",
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


def set_ctx_tokens(session_id: str, tokens: "int | None") -> None:
    """How full the window was on this session's last measured request. Written
    once per turn, not once per message — see runner._run_streaming."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET ctx_tokens=? WHERE id=?",
                  (tokens, session_id))


def get_autocompact(session_id: str) -> "str | None":
    """This session's auto-compact window, or None to leave the CLI's default."""
    with closing(_connect()) as c:
        row = c.execute("SELECT autocompact FROM sessions WHERE id=?",
                        (session_id,)).fetchone()
    return (row["autocompact"] or None) if row else None


def set_autocompact(session_id: str, value: "str | None") -> None:
    """Validated by the servers' normalize_autocompact, not here."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET autocompact=? WHERE id=?",
                  (value, session_id))


def set_work_cwd(session_id: str, path: "str | None") -> None:
    """Record (or clear, with None) the worktree this session's shell moved into.
    Verified as a worktree of the session's repo by the caller — this only
    stores."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET work_cwd=? WHERE id=?", (path, session_id))


def parse_goal(raw: "str | None") -> dict | None:
    """The stored goal JSON as {objective, state, iter}, or None. Shared with the
    session-brief serializer, which already holds the row and shouldn't re-query."""
    if not raw:
        return None
    try:
        g = json.loads(raw)
    except ValueError:
        return None                # hand-edited or truncated JSON — no goal
    return g if isinstance(g, dict) else None


def parse_str_list(raw: "str | None") -> list[str]:
    """A stored JSON array as a list of strings; anything malformed reads as []."""
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except ValueError:
        return []
    return [t for t in v if isinstance(t, str)] if isinstance(v, list) else []


# --- shares -----------------------------------------------------------------
# A share is a read-only view of one session at an unguessable URL, good until
# it expires. The token IS the authorisation, so it never appears in a list the
# dashboard shows to anyone but its owner, and every read re-checks the clock.

SHARE_MAX_DAYS = 7


def create_share(session_id: str, days: int = 7) -> dict:
    """Mint a share for `session_id`. Days is clamped to 1..7 — a link that
    outlives your memory of making it is the one that leaks."""
    days = max(1, min(SHARE_MAX_DAYS, int(days or 7)))
    now = time.time()
    row = {"token": secrets.token_urlsafe(24), "session_id": session_id,
           "created": now, "expires": now + days * 86400}
    with closing(_connect()) as c:
        c.execute("INSERT INTO shares(token,session_id,created,expires) "
                  "VALUES(?,?,?,?)",
                  (row["token"], session_id, row["created"], row["expires"]))
    return row


def get_share(token: str) -> "dict | None":
    """The live share for `token`, or None when it's unknown or expired. Expiry
    is enforced here rather than by a sweeper, so a link dies on time even if
    nothing has pruned the table."""
    if not token:
        return None
    with closing(_connect()) as c:
        r = c.execute("SELECT * FROM shares WHERE token=?", (token,)).fetchone()
    if r is None or r["expires"] <= time.time():
        return None
    return dict(r)


def list_shares(session_id: str) -> list[dict]:
    """Live shares for a session, newest first."""
    with closing(_connect()) as c:
        rows = c.execute(
            "SELECT * FROM shares WHERE session_id=? AND expires>? "
            "ORDER BY created DESC", (session_id, time.time())).fetchall()
    return [dict(r) for r in rows]


def revoke_shares(session_id: str) -> int:
    """Kill every share for a session. Returns how many were live."""
    live = len(list_shares(session_id))
    with closing(_connect()) as c:
        c.execute("DELETE FROM shares WHERE session_id=?", (session_id,))
    return live


def prune_shares() -> int:
    """Drop expired rows. Housekeeping only — get_share already refuses them."""
    with closing(_connect()) as c:
        cur = c.execute("DELETE FROM shares WHERE expires<=?", (time.time(),))
    return cur.rowcount or 0


# --- Inbound hooks -----------------------------------------------------------
# The token is the row's identity *and* its password (bridge/hooks.py explains
# why), so it is generated here and never derived from anything the caller sent.

# Events are kept for the feed panel, not forever: a chatty CI hook would grow
# this table without bound, and an event nobody read in a thousand pushes is not
# one anybody is going to.
HOOK_EVENTS_KEEP = 1000


def create_hook(label: str, source: str, secret: str = "") -> dict:
    """Mint a hook. `secret` empty means the path token is the only credential."""
    row = {"token": secrets.token_urlsafe(24), "label": (label or "hook").strip()[:60],
           "source": source, "secret": secret or None, "created": time.time(),
           "last_seen": None, "hits": 0}
    with closing(_connect()) as c:
        c.execute("INSERT INTO hooks(token,label,source,secret,created,hits) "
                  "VALUES(?,?,?,?,?,0)",
                  (row["token"], row["label"], source, row["secret"], row["created"]))
    return row


def get_hook(token: str) -> "dict | None":
    if not token:
        return None
    with closing(_connect()) as c:
        r = c.execute("SELECT * FROM hooks WHERE token=?", (token,)).fetchone()
    return dict(r) if r else None


def list_hooks() -> list[dict]:
    """Every hook, newest first. Secrets are replaced by a bool — the panel needs
    to show whether one is set, never what it is."""
    with closing(_connect()) as c:
        rows = c.execute("SELECT * FROM hooks ORDER BY created DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["signed"] = bool(d.pop("secret"))
        out.append(d)
    return out


def delete_hook(token: str) -> int:
    """Revoke. Its events go too — they are unreadable without the hook's label,
    and keeping them would make a revoked token look live in the feed."""
    with closing(_connect()) as c:
        c.execute("DELETE FROM hook_events WHERE token=?", (token,))
        cur = c.execute("DELETE FROM hooks WHERE token=?", (token,))
    return cur.rowcount or 0


def record_hook_event(token: str, source: str, title: "str | None",
                      url: "str | None", payload: str) -> dict:
    """Store one event, bump its hook's counters, trim the tail. One connection:
    a hook that fires in a burst should not queue behind its own bookkeeping."""
    row = {"id": uuid.uuid4().hex, "token": token, "source": source,
           "title": title, "url": url, "payload": payload, "received": time.time()}
    with closing(_connect()) as c:
        c.execute("INSERT INTO hook_events(id,token,source,title,url,payload,received) "
                  "VALUES(?,?,?,?,?,?,?)",
                  (row["id"], token, source, title, url, payload, row["received"]))
        c.execute("UPDATE hooks SET last_seen=?, hits=hits+1 WHERE token=?",
                  (row["received"], token))
        c.execute("DELETE FROM hook_events WHERE id NOT IN "
                  "(SELECT id FROM hook_events ORDER BY received DESC LIMIT ?)",
                  (HOOK_EVENTS_KEEP,))
    return row


def list_hook_events(limit: int = 50) -> list[dict]:
    """Recent events, newest first, with their hook's label joined in. The raw
    payload is excluded — the feed shows a line, and nothing reads it yet."""
    with closing(_connect()) as c:
        rows = c.execute(
            "SELECT e.id,e.token,e.source,e.title,e.url,e.received,h.label "
            "FROM hook_events e LEFT JOIN hooks h ON h.token=e.token "
            "ORDER BY e.received DESC LIMIT ?", (max(1, min(200, int(limit))),)
        ).fetchall()
    return [dict(r) for r in rows]


DEFAULT_TOOLS_KEY = "default_disabled_tools"


def default_disabled_tools() -> list[str]:
    """Deny rules a session starts with, until it's configured its own.

    Editable from the Tools modal (SAVE AS DEFAULT); config.MCP_SERVERS only
    seeds it the first time, so changing the default never needs a restart.

    Why there is a default at all: the configured MCP servers carry ~263k
    tokens of tool schemas — more than the whole 200k window — and Claude Code
    only *sometimes* loads them lazily. A session that draws the eager path is
    born over the limit and cannot recover ("Prompt is too long", then
    autocompact thrashing forever, because compaction shrinks the conversation
    and never the system prompt). Denying a server by bare name keeps its
    schemas out either way."""
    from bridge import toolsets  # local: toolsets imports runner
    stored = get_setting(DEFAULT_TOOLS_KEY)
    if stored is not None:
        return parse_str_list(stored)
    allowed = {s.strip() for s in config.MCP_SERVERS.split(",") if s.strip()}
    return sorted(s["rule"] for s in toolsets.servers() if s["name"] not in allowed)


def parse_disabled_tools(raw: "str | None") -> list[str]:
    """Deny rules for a session (see bridge/toolsets.py), from the stored column.

    NULL means never configured, and falls back to default_disabled_tools().
    A stored "[]" is a real choice (everything on) and is honoured — including
    by the run itself, which no longer re-denies on top."""
    return default_disabled_tools() if raw is None else parse_str_list(raw)


def get_setting(key: str) -> "str | None":
    with closing(_connect()) as c:
        row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(key: str, value: "str | None") -> None:
    """None deletes the key, which is how a setting goes back to its config default."""
    with closing(_connect()) as c:
        if value is None:
            c.execute("DELETE FROM settings WHERE key=?", (key,))
        else:
            c.execute("INSERT INTO settings(key, value) VALUES(?, ?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def get_disabled_tools(session_id: str) -> list[str]:
    """Deny rules switched on for this session (see bridge/toolsets.py)."""
    with closing(_connect()) as c:
        row = c.execute("SELECT disabled_tools FROM sessions WHERE id=?",
                        (session_id,)).fetchone()
    return parse_disabled_tools(row["disabled_tools"]) if row else []


def set_disabled_tools(session_id: str, rules: list[str]) -> None:
    # Always a JSON list, never NULL: "[]" has to mean "user switched everything
    # on" and stay distinguishable from the never-configured default above.
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET disabled_tools=? WHERE id=?",
                  (json.dumps(rules), session_id))


def get_goal(session_id: str) -> dict | None:
    """This session's goal as {objective, state, iter}, or None if it has none."""
    with closing(_connect()) as c:
        row = c.execute("SELECT goal FROM sessions WHERE id=?",
                        (session_id,)).fetchone()
    return parse_goal(row["goal"]) if row else None


def set_goal(session_id: str, goal: dict | None) -> None:
    """Replace this session's goal; None clears it."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET goal=? WHERE id=?",
                  (json.dumps(goal) if goal else None, session_id))


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


def rename(session_id: str, title: str) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET title=?, title_source='manual' WHERE id=?",
                  (title, session_id))


LIFECYCLES = ("done", "abandoned", "backlog")   # NULL = still active


def archive(session_id: str, archived: bool = True) -> None:
    """Hide/unhide a session. Keeps `lifecycle` in step so the two can't drift:
    archiving with no stated reason reads as 'done', un-archiving clears it."""
    with closing(_connect()) as c:
        c.execute(
            "UPDATE sessions SET archived=?, updated=?, "
            "lifecycle=CASE WHEN ?=1 THEN COALESCE(lifecycle,'done') ELSE NULL END "
            "WHERE id=?",
            (1 if archived else 0, time.time(), 1 if archived else 0, session_id))


def latest_turn_id(session_id: str) -> "str | None":
    with closing(_connect()) as c:
        row = c.execute("SELECT id FROM turns WHERE session_id=? "
                        "ORDER BY seq DESC LIMIT 1", (session_id,)).fetchone()
    return row["id"] if row else None


def turn_prompt(turn_id: str) -> "str | None":
    with closing(_connect()) as c:
        row = c.execute("SELECT prompt FROM turns WHERE id=?", (turn_id,)).fetchone()
    return row["prompt"] if row else None


def set_lifecycle(session_id: str, state: str | None) -> None:
    """Move a session to done/abandoned/backlog, or None to make it active again.
    `archived` is the derived 'hidden' flag — every existing query and the
    sessions index already filter on it, so nothing downstream learns a column.
    Validated by the callers against LIFECYCLES."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET lifecycle=?, archived=?, updated=? WHERE id=?",
                  (state, 0 if state is None else 1, time.time(), session_id))


# --- turns + events ---------------------------------------------------------

def recent_prompts(session_id: str, limit: int) -> list[str]:
    """The session's most recent user prompts, newest first. Empty when it has no
    turns yet — which is also how callers ask "does this session have history?"."""
    with closing(_connect()) as c:
        rows = c.execute("SELECT prompt FROM turns WHERE session_id=? "
                         "ORDER BY seq DESC LIMIT ?", (session_id, limit)).fetchall()
    return [r["prompt"] or "" for r in rows]


def prompt_history(limit: int = 200) -> list[str]:
    """Recent prompts across every session, newest first, one row per distinct
    text. Deliberately not per-session: what you reach for with Ctrl+R is usually
    a prompt you wrote in another session, not the one you're already in."""
    with closing(_connect()) as c:
        rows = c.execute(
            "SELECT prompt, MAX(started) AS last FROM turns "
            "WHERE prompt IS NOT NULL AND TRIM(prompt) <> '' "
            "GROUP BY prompt ORDER BY last DESC LIMIT ?", (limit,)).fetchall()
    return [r["prompt"] for r in rows]


def start_turn(session_id: str, turn_id: str, prompt: str,
               attachments: list[str] | None, model: str | None = None,
               runtime: str | None = None, sha: str | None = None) -> None:
    now = time.time()
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        seq = c.execute("SELECT COALESCE(MAX(seq),-1)+1 AS n FROM turns WHERE session_id=?",
                        (session_id,)).fetchone()["n"]
        c.execute(
            "INSERT INTO turns(id,session_id,seq,prompt,attachments,status,cost,"
            "elapsed,started,model,runtime,sha) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (turn_id, session_id, seq, prompt, json.dumps(attachments or []),
             "running", None, None, now, model, runtime, sha or None))
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


def set_turn_tokens(turn_id: str, tokens: "dict | None") -> None:
    """What this turn spent: the four API counters, summed over its messages.
    None (or a call that never happens) leaves the columns NULL, which reads as
    "unknown" rather than "free" — a turn from before this was recorded must not
    render as zero."""
    if not tokens:
        return
    with closing(_connect()) as c:
        c.execute("UPDATE turns SET tok_in=?, tok_out=?, tok_cache_w=?, "
                  "tok_cache_r=? WHERE id=?",
                  (int(tokens.get("in") or 0), int(tokens.get("out") or 0),
                   int(tokens.get("cache_w") or 0), int(tokens.get("cache_r") or 0),
                   turn_id))


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
            tok = t.get("tokens") or {}
            c.execute(
                "INSERT INTO turns(id,session_id,seq,prompt,attachments,status,cost,"
                "elapsed,started,model,tok_in,tok_out,tok_cache_w,tok_cache_r) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (t["id"], session_id, t["seq"], t.get("prompt", ""),
                 json.dumps(t.get("attachments") or []), t.get("status", "done"),
                 t.get("cost"), t.get("elapsed"), t.get("started") or time.time(),
                 t.get("model"),
                 # NULL, not 0, when the transcript never reported usage.
                 tok.get("in"), tok.get("out"),
                 tok.get("cache_w"), tok.get("cache_r")))
        for e in events:
            payload = {k: v for k, v in e.items() if k not in ("seq", "turn_id")}
            c.execute("INSERT INTO events(session_id,turn_id,seq,type,payload,ts) "
                      "VALUES(?,?,?,?,?,?)",
                      (session_id, e["turn_id"], e["seq"], e.get("type", ""),
                       json.dumps(payload), e.get("ts") or time.time()))
        c.execute("COMMIT")
    return True


def duplicate(session_id: str) -> dict | None:
    """Copy a session — row, turns and events — into a new one. Returns the copy.

    The copy takes the source's claude session id as `fork_from` rather than as
    its own: its first run resumes that transcript with --fork-session, so claude
    mints a fresh id and the original is never appended to. Goal and lifecycle are
    deliberately NOT copied — a copy is a fresh line of work, not a second session
    racing the same objective."""
    src = get_session(session_id)
    if not src:
        return None
    title = (src.get("title") or "session")[:52] + " (copy)"
    copy = create_session(
        src["chat_id"], src["project"], origin=src.get("origin"),
        cwd=src.get("cwd"), permission_mode=src.get("permission_mode"))
    now = time.time()
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute("UPDATE sessions SET title=?, title_source=?, fork_from=?, "
                  "fallback_policy=?, updated=? WHERE id=?",
                  (title, "manual", src.get("claude_session_id"),
                   src.get("fallback_policy"), now, copy["id"]))
        # New turn ids so the two sessions' turns never collide; events follow
        # their turn through the same map.
        idmap = {}
        for t in c.execute("SELECT * FROM turns WHERE session_id=? ORDER BY seq",
                           (session_id,)).fetchall():
            idmap[t["id"]] = uuid.uuid4().hex
            c.execute(
                "INSERT INTO turns(id,session_id,seq,prompt,attachments,status,cost,"
                "elapsed,started,model,runtime,sha) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (idmap[t["id"]], copy["id"], t["seq"], t["prompt"], t["attachments"],
                 t["status"], t["cost"], t["elapsed"], t["started"], t["model"],
                 t["runtime"], t["sha"]))
        for e in c.execute("SELECT * FROM events WHERE session_id=? ORDER BY seq",
                           (session_id,)).fetchall():
            c.execute("INSERT INTO events(session_id,turn_id,seq,type,payload,ts) "
                      "VALUES(?,?,?,?,?,?)",
                      (copy["id"], idmap.get(e["turn_id"], e["turn_id"]), e["seq"],
                       e["type"], e["payload"], e["ts"]))
        c.execute("COMMIT")
    return get_session(copy["id"])


def relocate(session_id: str, new_cwd: str) -> int:
    """Point a session at a different directory and rewrite the old path wherever
    it appears in prompts and event payloads, so the model never sees the move.

    Returns the number of rows rewritten. Plain string substitution on the old cwd
    — the paths in a transcript are literal, and anything cleverer would have to
    understand every tool's payload shape."""
    src = get_session(session_id)
    if not src:
        return 0
    old = (src.get("cwd") or "").rstrip("/")
    new = new_cwd.rstrip("/")
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        # work_cwd goes too: it named a detour from the *old* checkout.
        c.execute("UPDATE sessions SET cwd=?, work_cwd=NULL, updated=? WHERE id=?",
                  (new, time.time(), session_id))
        n = 0
        # No old cwd, or a no-op move: retarget the session and stop. Substituting
        # an empty string would splice `new` between every character.
        if old and old != new:
            for tbl, col in (("turns", "prompt"), ("events", "payload")):
                cur = c.execute(
                    f"UPDATE {tbl} SET {col}=REPLACE({col}, ?, ?) "
                    f"WHERE session_id=? AND instr({col}, ?) > 0",
                    (old, new, session_id, old))
                n += cur.rowcount
        c.execute("COMMIT")
    return n


def history(chat_id: int, include_archived: bool = False,
            max_age_secs: float | None = LIST_MAX_AGE_SECS) -> list[dict]:
    """Per-repo session rollup: one row per session with aggregates joined from
    its turns — turn_count, total_elapsed, total_tokens, last_activity, and the
    distinct models used. Newest activity first.

    Time and tokens rather than dollars: 9f612a4 removed the dollar readouts
    because the CLI prices these runs off API list rates while they go through a
    subscription. total_tokens is NULL, not 0, when no turn ever reported usage —
    a session that predates the columns is unknown, not free."""
    q = ("SELECT s.id, s.title, s.project, s.origin, s.created, s.updated, s.archived, "
         "s.lifecycle, "
         "COUNT(t.id) AS turn_count, "
         "COALESCE(SUM(t.elapsed), 0) AS total_elapsed, "
         "SUM(COALESCE(t.tok_in,0) + COALESCE(t.tok_out,0) "
         "  + COALESCE(t.tok_cache_w,0) + COALESCE(t.tok_cache_r,0)) "
         "  FILTER (WHERE t.tok_in IS NOT NULL OR t.tok_out IS NOT NULL "
         "     OR t.tok_cache_w IS NOT NULL OR t.tok_cache_r IS NOT NULL) "
         "  AS total_tokens, "
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


def today(chat_id: int, since: float) -> dict:
    """What this chat has spent since `since` (local midnight, computed by the
    caller — the DB stores epoch seconds and knows nothing about timezones).

    Tokens and turns, not dollars: 9f612a4 took the dollar readouts out because
    the CLI prices these runs at API list rate while they go through a
    subscription. `cost` is summed anyway for the callers that run on a real
    API key, where the number means something; it is NULL when no turn in the
    window reported one, which is not the same as $0.00."""
    with closing(_connect()) as c:
        r = c.execute(
            "SELECT COUNT(t.id) AS turns, "
            "COALESCE(SUM(COALESCE(t.tok_in,0) + COALESCE(t.tok_out,0) "
            "  + COALESCE(t.tok_cache_w,0) + COALESCE(t.tok_cache_r,0)), 0) AS tokens, "
            "SUM(t.cost) AS cost "
            "FROM turns t JOIN sessions s ON s.id = t.session_id "
            "WHERE s.chat_id=? AND t.started >= ?", (chat_id, since)).fetchone()
    return {"turns": r["turns"], "tokens": r["tokens"], "cost": r["cost"]}


def week_by_project(chat_id: int, since: float, until: float) -> list[dict]:
    """Per-project aggregates over turns started in [since, until): sessions
    touched (not created — an old session worked on this week counts), turns,
    wall seconds, the four token counters and models used. Each token column is
    a bare SUM, so it is NULL when no turn in the window ever reported that
    counter — unknown, not free, same semantics as history()."""
    with closing(_connect()) as c:
        rows = c.execute(
            "SELECT s.project, COUNT(DISTINCT s.id) AS sessions, "
            "COUNT(t.id) AS turns, COALESCE(SUM(t.elapsed), 0) AS elapsed, "
            "SUM(t.tok_in) AS tok_in, SUM(t.tok_out) AS tok_out, "
            "SUM(t.tok_cache_w) AS tok_cache_w, SUM(t.tok_cache_r) AS tok_cache_r, "
            "GROUP_CONCAT(DISTINCT t.model) AS models "
            "FROM turns t JOIN sessions s ON s.id = t.session_id "
            "WHERE s.chat_id=? AND t.started >= ? AND t.started < ? "
            "GROUP BY s.project ORDER BY elapsed DESC",
            (chat_id, since, until)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["models"] = sorted(m for m in (d.pop("models") or "").split(",") if m)
        out.append(d)
    return out


def week_by_day(chat_id: int, since: float, until: float) -> list[dict]:
    """Turns and wall seconds per local calendar day; only days with activity.
    'localtime' matches the /local/today convention — the DB stores epoch
    seconds and the buckets have to agree with the user's midnight."""
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(
            "SELECT date(t.started, 'unixepoch', 'localtime') AS day, "
            "COUNT(t.id) AS turns, COALESCE(SUM(t.elapsed), 0) AS elapsed "
            "FROM turns t JOIN sessions s ON s.id = t.session_id "
            "WHERE s.chat_id=? AND t.started >= ? AND t.started < ? "
            "GROUP BY day ORDER BY day", (chat_id, since, until)).fetchall()]


def turn_metrics(session_id: str) -> list[dict]:
    """Per-turn status, wall time and token spend — the numbers a breakdown adds
    up. Ordered by seq so a caller can attribute per turn as well as per session."""
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(
            "SELECT seq, status, elapsed, started, tok_in, tok_out, tok_cache_w, "
            "tok_cache_r FROM turns WHERE session_id=? ORDER BY seq",
            (session_id,)).fetchall()]


def timed_events(session_id: str) -> list[dict]:
    """Every event that carries a duration, with the ts it ended at: `tool` (to
    name a call), `tool_done` (ms) and `thinking` (ms). The rows a wall-clock
    attribution is reconstructed from."""
    with closing(_connect()) as c:
        rows = c.execute(
            "SELECT type, payload, ts FROM events WHERE session_id=? "
            "AND type IN ('tool','tool_done','thinking') ORDER BY seq",
            (session_id,)).fetchall()
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict):
            out.append({"type": r["type"], "ts": r["ts"], **payload})
    return out


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
            "SELECT seq,turn_id,payload,ts FROM events WHERE session_id=? AND seq>=? ORDER BY seq",
            (session_id, cursor)).fetchall()
    events = []
    for r in evrows:
        d = json.loads(r["payload"])
        d["seq"] = r["seq"]
        d["turn_id"] = r["turn_id"]
        # When it landed, so a surface can show a turn-relative clock against
        # turns.started. Carried on the row since the schema's first version;
        # it was simply never handed out.
        d["at"] = r["ts"]
        events.append(d)
    for t in turns:
        # Stored as bare filenames; handed out as the upload-dir paths both
        # surfaces serve back (/local/attachment, /api/attachment) — so reopening
        # a session shows the screenshots you sent, not a paperclip count. The
        # turn id IS the run's upload dir, so old turns resolve too.
        t["attachments"] = [os.path.join(config.UPLOAD_DIR, t["id"], os.path.basename(n))
                            for n in json.loads(t["attachments"])]
    next_cursor = (events[-1]["seq"] + 1) if events else cursor
    return {"session": s, "turns": turns, "events": events, "next_cursor": next_cursor}


