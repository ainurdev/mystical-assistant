"""Machine-wide view of *external* Claude Code sessions running on this host.

Source of truth is Claude Code's own session registry: one
`~/.claude/sessions/<pid>.json` file per process, written by interactive
clients (VS Code, terminal `claude`). Liveness is exact — the PID is alive or it
isn't — so this never guesses from mtime.

This covers only interactive sessions. The bridge's own `claude -p` children DO
register here (entrypoint "sdk-cli") but are dropped: they are already tracked in
the store (see store.running_session_ids), so listing them again would show every
running chat twice — once with its real title, once as a nameless folder row.
Stdlib only.
"""

import json
import os

SESSIONS_DIR = os.path.expanduser("~/.claude/sessions")
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
_HOME = os.path.expanduser("~")


def _transcript_mtime(session_id: str, cwd: str) -> float | None:
    """mtime of the session's transcript JSONL, the truest 'last activity' signal.

    Claude Code appends to `~/.claude/projects/<enc>/<sessionId>.jsonl` on every
    turn, where <enc> is the cwd with `/`, `.`, `_` collapsed to `-`. The session
    registry file (in SESSIONS_DIR) is frozen at start for VS Code, so its mtime
    is useless for activity; the transcript is the reliable source. None if absent."""
    if not session_id or not cwd:
        return None
    enc = cwd.replace("/", "-").replace(".", "-").replace("_", "-")
    try:
        return os.path.getmtime(os.path.join(PROJECTS_DIR, enc, f"{session_id}.jsonl"))
    except OSError:
        return None


def _alive(pid) -> bool:
    """True iff the process exists. `kill(pid, 0)` raises ProcessLookupError when
    it's gone and PermissionError when it exists but we may not signal it."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _short(path: str) -> str:
    """Collapse the home prefix to ~ so we don't surface full $HOME paths."""
    if path and path.startswith(_HOME):
        return "~" + path[len(_HOME):]
    return path


def _source(entrypoint: str) -> str:
    e = (entrypoint or "").lower()
    if "vscode" in e:
        return "vscode"
    if "sdk" in e:
        return "sdk"
    if "cli" in e:
        return "cli"
    return e or "cli"


def _row(raw: dict) -> dict | None:
    """Normalize one registry record into a UI row, or None if unusable.

    `status`/`waitingFor` are only populated for the terminal CLI entrypoint;
    VS Code records carry neither, so those rows are presence-only."""
    sid = raw.get("sessionId")
    pid = raw.get("pid")
    if not sid or pid is None:
        return None
    cwd = raw.get("cwd") or ""
    started = raw.get("startedAt")
    if isinstance(started, (int, float)):
        started = started / 1000.0 if started > 1e12 else float(started)  # ms -> s
    else:
        started = None
    return {
        "session_id": sid,
        "pid": pid,
        "project": os.path.basename(cwd.rstrip("/")) or cwd or "?",
        "cwd": _short(cwd),
        "source": _source(raw.get("entrypoint", "")),
        "started": started,
        "status": raw.get("status"),
        "waiting_for": raw.get("waitingFor"),
    }


def list_running() -> list[dict]:
    """Every live external session, newest first."""
    out: list[dict] = []
    try:
        names = os.listdir(SESSIONS_DIR)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(SESSIONS_DIR, name)
        try:
            with open(path) as f:
                raw = json.load(f)
        except (OSError, ValueError):
            continue
        if not _alive(raw.get("pid")):
            continue
        row = _row(raw)
        if row and row["source"] != "sdk":  # skip our own children — see docstring
            # "last activity" = newest of the transcript mtime (real per-turn
            # signal) and the registry mtime (CLI updates it; VS Code freezes it
            # at start). Drives the dashboard's idle / 30-min-window logic.
            try:
                reg = os.path.getmtime(path)
            except OSError:
                reg = row["started"] or 0.0
            tx = _transcript_mtime(row["session_id"], raw.get("cwd") or "")
            row["last_active"] = max(reg, tx) if tx is not None else reg
            out.append(row)
    out.sort(key=lambda r: r["started"] or 0, reverse=True)
    return out
