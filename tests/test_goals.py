"""Goal loop: state transitions, the iteration cap, and the MCP tool server."""

import json
import os

from bridge import goal_mcp, goals, store

store.init()


def _session() -> str:
    sid = store.create_session(555, "/goaltest", origin="dashboard")
    return sid["id"] if isinstance(sid, dict) else sid


def test_create_and_get_roundtrip():
    sid = _session()
    assert goals.get(sid) is None
    goals.create(sid, "  ship the thing  ")
    g = goals.get(sid)
    assert g["objective"] == "ship the thing"     # trimmed
    assert g["state"] == goals.ACTIVE
    assert g["iter"] == 0


def test_should_continue_respects_state_and_cap():
    assert goals.should_continue(None) is False
    assert goals.should_continue({"state": goals.ACTIVE, "iter": 0}) is True
    assert goals.should_continue({"state": goals.COMPLETE, "iter": 0}) is False
    assert goals.should_continue({"state": goals.BLOCKED, "iter": 0}) is False
    # The cap is the brake on an unattended loop.
    assert goals.should_continue(
        {"state": goals.ACTIVE, "iter": goals.MAX_ITER - 1}) is True
    assert goals.should_continue(
        {"state": goals.ACTIVE, "iter": goals.MAX_ITER}) is False


def test_mark_complete_stops_the_loop():
    sid = _session()
    goals.create(sid, "refactor the parser")
    goals.mark(sid, goals.COMPLETE, "done in 3 files")
    g = goals.get(sid)
    assert g["state"] == goals.COMPLETE
    assert g["note"] == "done in 3 files"
    assert goals.should_continue(g) is False


def test_mark_without_a_goal_is_a_noop():
    assert goals.mark(_session(), goals.COMPLETE) is None


def test_clear_removes_the_goal():
    sid = _session()
    goals.create(sid, "x")
    goals.clear(sid)
    assert goals.get(sid) is None


def test_corrupt_goal_json_reads_as_no_goal():
    sid = _session()
    with store._connect() as c:                    # noqa: SLF001 — corrupt on purpose
        c.execute("UPDATE sessions SET goal=? WHERE id=?", ("{not json", sid))
    assert store.get_goal(sid) is None


# --- the MCP tool server -----------------------------------------------------

def _rpc(method, params=None, rid=1):
    return goal_mcp._handle(                       # noqa: SLF001 — the unit under test
        {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def _bind(sid: str) -> None:
    """Point the tool server at a session the way --mcp-config's env does."""
    row = store.get_session(sid)
    csid = row.get("claude_session_id")
    if not csid:
        csid = "csid-" + sid
        store.set_claude_session_id(sid, csid)
    os.environ["MYSTICAL_CLAUDE_SESSION_ID"] = csid


def test_initialize_and_tools_list():
    init = _rpc("initialize")["result"]
    assert init["protocolVersion"] == goal_mcp.PROTOCOL
    names = {t["name"] for t in _rpc("tools/list")["result"]["tools"]}
    assert names == {"CreateGoal", "UpdateGoal", "GetGoal"}


def test_notification_gets_no_response():
    assert goal_mcp._handle({"jsonrpc": "2.0",          # noqa: SLF001
                             "method": "notifications/initialized"}) is None


def test_unknown_method_is_an_error_not_a_crash():
    err = _rpc("nope/nope")["error"]
    assert err["code"] == -32601


def test_tool_call_creates_then_completes_a_goal():
    sid = _session()
    _bind(sid)
    out = _rpc("tools/call", {"name": "CreateGoal",
                              "arguments": {"objective": "green the suite"}})
    assert "green the suite" in out["result"]["content"][0]["text"]
    assert goals.get(sid)["state"] == goals.ACTIVE

    _rpc("tools/call", {"name": "UpdateGoal", "arguments": {"state": "complete"}})
    assert goals.get(sid)["state"] == goals.COMPLETE


def test_get_goal_reports_progress():
    sid = _session()
    _bind(sid)
    _rpc("tools/call", {"name": "CreateGoal", "arguments": {"objective": "abc"}})
    text = _rpc("tools/call", {"name": "GetGoal"})["result"]["content"][0]["text"]
    assert "abc" in text and f"0/{goals.MAX_ITER}" in text


def test_bad_state_is_rejected():
    sid = _session()
    _bind(sid)
    _rpc("tools/call", {"name": "CreateGoal", "arguments": {"objective": "abc"}})
    text = _rpc("tools/call", {"name": "UpdateGoal",
                               "arguments": {"state": "donezo"}})["result"]["content"][0]["text"]
    assert "must be" in text
    assert goals.get(sid)["state"] == goals.ACTIVE      # unchanged


def test_unbound_server_refuses_rather_than_guessing():
    os.environ["MYSTICAL_CLAUDE_SESSION_ID"] = ""
    text = _rpc("tools/call", {"name": "GetGoal"})["result"]["content"][0]["text"]
    assert "No session bound" in text


def test_mcp_config_carries_the_session_and_repo_root():
    from bridge import runner
    cfg = json.loads(runner._goal_mcp_config("abc-123"))   # noqa: SLF001
    env = cfg["mcpServers"]["goals"]["env"]
    assert env["MYSTICAL_CLAUDE_SESSION_ID"] == "abc-123"
    assert os.path.isdir(os.path.join(env["PYTHONPATH"], "bridge"))
