"""Stdio MCP server exposing the goal tools to the `claude` child process.

Spawned per interactive run via --mcp-config. The claude session id arrives in
MYSTICAL_CLAUDE_SESSION_ID and resolves to the store row through the index that
already exists on that column, so the tools write straight into the bridge's own
store and the loop in goals.py sees the model's verdict at the next turn boundary.

Stdlib only, line-delimited JSON-RPC 2.0 on stdin/stdout. Nothing is logged to
stdout — that channel is the protocol.
"""

import json
import os
import sys

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
    return f"Unknown tool: {name}"


def _handle(req: dict) -> dict | None:
    """One JSON-RPC request in, one response out. None for notifications."""
    method, rid = req.get("method"), req.get("id")
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL,
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "mystical-goals", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": _TOOLS}
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
