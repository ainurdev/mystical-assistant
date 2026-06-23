"""Machine-wide view of *external* Claude Code sessions running on this host.

Source of truth is Claude Code's own session registry: one
`~/.claude/sessions/<pid>.json` file per process, written by interactive
clients (VS Code, terminal `claude`). Liveness is exact — the PID is alive or it
isn't — so this never guesses from mtime.

This covers only interactive sessions; the bridge's own `claude -p` runs do NOT
register here. Those are tracked in the store (see store.running_session_ids).
Stdlib only.
"""

import json
import os

SESSIONS_DIR = os.path.expanduser("~/.claude/sessions")
_HOME = os.path.expanduser("~")


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
        try:
            with open(os.path.join(SESSIONS_DIR, name)) as f:
                raw = json.load(f)
        except (OSError, ValueError):
            continue
        if not _alive(raw.get("pid")):
            continue
        row = _row(raw)
        if row:
            out.append(row)
    out.sort(key=lambda r: r["started"] or 0, reverse=True)
    return out
