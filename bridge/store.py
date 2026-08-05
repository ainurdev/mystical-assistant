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
  tags              TEXT,
  fork_from         TEXT
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
  sha         TEXT
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
        # Topic tags as a JSON array; NULL/[] = untagged. Written by the titler's
        # existing one-shot, so tagging costs no extra model call.
        if "tags" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN tags TEXT")
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
        # Which runtime produced a turn (NULL = the default Claude account,
        # else 'claude:<slot>' or 'opencode:<provider>').
        if "runtime" not in cols:
            c.execute("ALTER TABLE turns ADD COLUMN runtime TEXT")
        # Commit HEAD pointed at when the turn started, so a checkpoint can show
        # what the tree has drifted since. NULL = not a repo / predates this.
        if "sha" not in cols:
            c.execute("ALTER TABLE turns ADD COLUMN sha TEXT")
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


MAX_TAGS = 4
_TAG_MAX_LEN = 24


def parse_tags(raw: "str | None") -> list[str]:
    """Stored tag JSON as a list of strings; anything malformed reads as no tags."""
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except ValueError:
        return []
    return [t for t in v if isinstance(t, str)] if isinstance(v, list) else []


def clean_tags(tags) -> list[str]:
    """Normalize model- or user-supplied tags: lowercase, trimmed, deduped, capped.
    Shared by the titler and the manual-tag endpoint so both store the same shape."""
    out: list[str] = []
    for t in tags if isinstance(tags, list) else []:
        t = " ".join(str(t).split()).strip("#").lower()[:_TAG_MAX_LEN].strip()
        if t and t not in out:
            out.append(t)
    return out[:MAX_TAGS]


def get_tags(session_id: str) -> list[str]:
    with closing(_connect()) as c:
        row = c.execute("SELECT tags FROM sessions WHERE id=?",
                        (session_id,)).fetchone()
    return parse_tags(row["tags"]) if row else []


def set_tags(session_id: str, tags) -> list[str]:
    """Replace this session's tags. Returns what was actually stored."""
    clean = clean_tags(tags)
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET tags=? WHERE id=?",
                  (json.dumps(clean) if clean else None, session_id))
    return clean


def tag_counts() -> "list[dict]":
    """Every tag in use with how many sessions carry it, most-used first. The
    tag list is derived, not a table — a tag exists exactly as long as some
    session wears it."""
    counts: dict[str, int] = {}
    with closing(_connect()) as c:
        for row in c.execute("SELECT tags FROM sessions WHERE tags IS NOT NULL"):
            for t in parse_tags(row["tags"]):
                counts[t] = counts.get(t, 0) + 1
    return [{"tag": t, "count": n} for t, n in
            sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def retag(old: str, new: "str | None") -> int:
    """Rename `old` to `new` across every session, or drop it when `new` is None.
    Renaming onto an existing tag is a merge — a session wearing both ends up
    with one, because tags are a set. Returns the number of sessions changed."""
    old = (old or "").strip().lower()
    if not old:
        return 0
    dest = clean_tags([new]) if new else []
    changed = 0
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        rows = c.execute(
            "SELECT id, tags FROM sessions WHERE tags IS NOT NULL").fetchall()
        for row in rows:
            tags = parse_tags(row["tags"])
            if old not in tags:
                continue
            # Position is preserved on a rename: the tag keeps its place in the
            # row's strip rather than jumping to the end.
            out: list[str] = []
            for t in tags:
                t = dest[0] if (t == old and dest) else t
                if t != old and t not in out:
                    out.append(t)
            c.execute("UPDATE sessions SET tags=? WHERE id=?",
                      (json.dumps(out) if out else None, row["id"]))
            changed += 1
        c.execute("COMMIT")
    return changed


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


def parse_disabled_tools(raw: "str | None") -> list[str]:
    """Deny rules for a session (see bridge/toolsets.py), from the stored column.

    NULL means never configured, and that defaults to every MCP server denied.
    The configured servers carry ~275k tokens of tool schemas — more than the
    200k window — and Claude Code only *sometimes* loads them lazily. A session
    that draws the eager path is born over the limit and cannot recover:
    "Prompt is too long", then autocompact thrashing forever, because compaction
    shrinks the conversation and never the system prompt. Denying a server by
    bare name keeps its schemas out either way.

    A stored "[]" is a real choice (everything on) and is honoured."""
    if raw is None:
        from bridge import toolsets  # local: toolsets imports runner
        return [s["rule"] for s in toolsets.servers()]
    return parse_tags(raw)


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
                  "tags=?, fallback_policy=?, updated=? WHERE id=?",
                  (title, "manual", src.get("claude_session_id"), src.get("tags"),
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
        c.execute("UPDATE sessions SET cwd=?, updated=? WHERE id=?",
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
    its turns — turn_count, total_cost, last_activity, and distinct models used.
    Newest activity first."""
    q = ("SELECT s.id, s.title, s.project, s.origin, s.created, s.updated, s.archived, "
         "s.lifecycle, "
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


