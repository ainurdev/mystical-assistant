"""Stdio MCP server exposing the goal tools to the `claude` child process.

Spawned per interactive run via --mcp-config. The claude session id arrives in
MYSTICAL_CLAUDE_SESSION_ID and resolves to the store row through the index that
already exists on that column, so the tools write straight into the bridge's own
store and the loop in goals.py sees the model's verdict at the next turn boundary.

WaitForSession and the two Rivendell task tools only relay: the bridge process
holds what they need (the waits, the Rivendell connections and token), so they
ask it over the dashboard's localhost API. The Rivendell tools are listed only
where they can work (_rivendell_on).

Stdlib only, line-delimited JSON-RPC 2.0 on stdin/stdout. Nothing is logged to
stdout — that channel is the protocol.
"""

import json
import os
import sys
import urllib.error
import urllib.request

from bridge import goals, store

PROTOCOL = "2024-11-05"

_TOOLS = [
    {
        "name": "CreateGoal",
        "description": (
            "Set an objective to keep working on across turns. After each turn "
            "you will be re-prompted with it until you mark it complete."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "objective": {
                    "type": "string",
                    "description": "What must be true for this to be done.",
                },
            },
            "required": ["objective"],
        },
    },
    {
        "name": "UpdateGoal",
        "description": (
            "Mark the active goal complete, or blocked when you need the user. "
            "Call this the moment the objective is met — it is the only thing "
            "that stops the loop."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "state": {"type": "string", "enum": ["complete", "blocked"]},
                "note": {
                    "type": "string",
                    "description": "Why it is blocked, or what was delivered.",
                },
            },
            "required": ["state"],
        },
    },
    {
        "name": "GetGoal",
        "description": "Read the active objective and how many turns it has run.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "WaitForSession",
        "description": (
            "Call this instead of ending a turn with \"I'll do X once session Y "
            "finishes\". The bridge marks this session WAITING and wakes it with a "
            "prompt when Y's turn ends, saying how it went. After calling it, end "
            "your turn with one line saying what you are waiting for. A prompt from "
            "the user ends the wait; call this again if you still need to wait."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session": {
                    "type": "string",
                    "description": ("The other session's id, or words from its title or "
                                    "worktree. \"?\" lists the sessions running now."),
                },
                "then": {
                    "type": "string",
                    "description": "What you will do when it finishes, in one sentence.",
                },
            },
            "required": ["session"],
        },
    },
]

_REPO_DOC = ("The checkout you are changing, when it isn't this session's own folder: "
             "absolute, or relative to that folder.")

# Listed only where they can work (_rivendell_on): a repo's work tracked on its
# Rivendell board (bridge/rivendell.py work_list / work_create).
_RV_TOOLS = [
    {
        "name": "ListRivendellTasks",
        "description": (
            "The open Rivendell tasks for the repo you are changing, and the board (and "
            "list) a new task would land on. Call it before you change code for a piece "
            "of work, to find the task that covers it."),
        "inputSchema": {
            "type": "object",
            "properties": {"repo": {"type": "string", "description": _REPO_DOC}},
        },
    },
    {
        "name": "CreateRivendellTask",
        "description": (
            "File a Rivendell task, tagged unplanned, for work no open task covers. Call "
            "it only after the user said yes on a card. It answers with the task's key: "
            "put that in the branch name and the PR title."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "What the work does, as a task title."},
                "description": {"type": "string",
                                "description": "Two or three sentences: what you are changing and why."},
                "board": {"type": "string",
                          "description": "The board's name, when ListRivendellTasks showed more than one."},
                "repo": {"type": "string", "description": _REPO_DOC},
            },
            "required": ["title"],
        },
    },
]


def _session_id() -> str:
    """Store session id for the run that spawned us, via the claude session id."""
    csid = os.environ.get("MYSTICAL_CLAUDE_SESSION_ID", "")
    if not csid:
        return ""
    row = store.get_by_claude_session_id(csid)
    return (row or {}).get("id") or ""


def _call(name: str, args: dict) -> str:
    sid = _session_id()
    if not sid:
        return "No session bound to this server; goals are unavailable."
    if name == "CreateGoal":
        objective = (args.get("objective") or "").strip()
        if not objective:
            return "objective is required."
        goals.create(sid, objective)
        return (f"Goal set: {objective}\nYou will be re-prompted after each turn "
                f"for up to {goals.MAX_ITER} turns until you call UpdateGoal.")
    if name == "UpdateGoal":
        state = (args.get("state") or "").strip()
        if state not in (goals.COMPLETE, goals.BLOCKED):
            return "state must be 'complete' or 'blocked'."
        if goals.mark(sid, state, (args.get("note") or "").strip()) is None:
            return "No active goal on this session."
        return f"Goal marked {state}. The loop will stop after this turn."
    if name == "GetGoal":
        goal = goals.get(sid)
        if not goal:
            return "No active goal on this session."
        return (f"Objective: {goal.get('objective')}\n"
                f"State: {goal.get('state')}\n"
                f"Turns used: {goal.get('iter', 0)}/{goals.MAX_ITER}")
    if name == "WaitForSession":
        return _wait(args)
    if name in ("ListRivendellTasks", "CreateRivendellTask"):
        return _rivendell(name, args)
    return f"Unknown tool: {name}"


def _bridge(path: str, body: dict, what: str, timeout: float = 15) -> str:
    """POST to the dashboard's localhost API as this run's session, and return
    its answer's text. `what` finishes "the bridge can't …" when it is down."""
    base = os.environ.get("MYSTICAL_DASH")
    if not base:
        return f"The dashboard is not running, so the bridge can't {what}."
    data = json.dumps({**body, "claude_session_id": os.environ.get("MYSTICAL_CLAUDE_SESSION_ID", "")}).encode()
    req = urllib.request.Request(
        base.rstrip("/") + path, data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "X-Dash-Token": os.environ.get("MYSTICAL_DASH_TOKEN", "")})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r).get("text") or "Done."
    except (urllib.error.URLError, OSError, ValueError) as e:  # noqa: BLE001
        return f"Could not reach the bridge: {e}"


def _wait(args: dict) -> str:
    """The bridge holds the wait (bridge/waits.py): it is the process that hears
    turns end, so this asks it over the dashboard's localhost API."""
    return _bridge("/local/wait", {"session": str(args.get("session") or ""),
                                   "then": str(args.get("then") or "")}, "hold a wait")


def _rivendell_on() -> bool:
    """Whether the Rivendell tools can work here: Rivendell installed with a
    connection switched on, the RIVENDELL TASKS switch on, and a session that
    isn't one of Rivendell's own runs. Those run unattended, so nobody would
    answer the card. A read that fails means no."""
    try:
        from bridge import aifeatures, integrations, rivendell_instances
        if not (integrations.installed("rivendell") and aifeatures.enabled("rvtrack")
                and any(i.get("enable") for i in rivendell_instances.instances())):
            return False
        csid = os.environ.get("MYSTICAL_CLAUDE_SESSION_ID", "")
        row = store.get_by_claude_session_id(csid) if csid else None
        return bool(row) and not str(row.get("origin") or "").startswith("rivendell")
    except Exception:  # noqa: BLE001 — tools/list must still answer
        return False


def _rivendell(name: str, args: dict) -> str:
    """The bridge holds the Rivendell connections and their token, so this asks
    it, as _wait does. Only the four fields pass: an `action` in the arguments
    can't turn a list into a create. A create makes several Rivendell calls,
    hence the longer wait; one that answers late and is retried is refused as a
    duplicate there, not filed twice."""
    body = {k: str(args[k]) for k in ("title", "description", "board", "repo") if args.get(k)}
    body["action"] = "create" if name == "CreateRivendellTask" else "list"
    return _bridge("/local/rivendell/work", body, "reach Rivendell", timeout=60)


def _handle(req: dict) -> dict | None:
    """One JSON-RPC request in, one response out. None for notifications."""
    method, rid = req.get("method"), req.get("id")
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL,
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "mystical-goals", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": _TOOLS + (_RV_TOOLS if _rivendell_on() else [])}
    elif method == "tools/call":
        params = req.get("params") or {}
        text = _call(params.get("name") or "", params.get("arguments") or {})
        result = {"content": [{"type": "text", "text": text}]}
    elif rid is None:
        return None                     # notification (e.g. initialized)
    else:
        return {"jsonrpc": "2.0", "id": rid,
                "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = _handle(json.loads(line))
        except Exception as e:  # noqa: BLE001 — a bad frame must not kill the server
            print(f"[goal_mcp] {e}", file=sys.stderr)
            continue
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
