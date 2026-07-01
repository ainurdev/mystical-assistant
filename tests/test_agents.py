"""Unit tests for the read-only subagent activity view (bridge/agents.py)."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import agents, transcript_jsonl  # noqa: E402


def _fixture():
    """Build ~/.claude/projects-style tree: main transcript + 2 subagents.
    agent a1's Task (T1) has a tool_result in main → done; a2 (T2) → running."""
    root = tempfile.mkdtemp()
    sid = "11111111-2222-3333-4444-555555555555"
    proj = os.path.join(root, "-tmp-proj")
    sub = os.path.join(proj, sid, "subagents")
    os.makedirs(sub, exist_ok=True)
    # main transcript with one completed Task tool_result (T1)
    with open(os.path.join(proj, sid + ".jsonl"), "w") as f:
        f.write(json.dumps({"type": "assistant", "message": {"role": "assistant",
                "content": [{"type": "tool_use", "id": "T1", "name": "Task",
                             "input": {"description": "d1"}}]}}) + "\n")
        f.write(json.dumps({"type": "user", "message": {"role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "T1",
                             "content": "ok"}]}}) + "\n")
    # agent a1 (done): meta + jsonl with one assistant text + one tool_use
    with open(os.path.join(sub, "agent-a1.meta.json"), "w") as f:
        json.dump({"agentType": "general-purpose", "description": "first agent",
                   "toolUseId": "T1", "spawnDepth": 1}, f)
    with open(os.path.join(sub, "agent-a1.jsonl"), "w") as f:
        f.write(json.dumps({"type": "user", "isSidechain": True,
                "message": {"role": "user", "content": "do first thing"}}) + "\n")
        f.write(json.dumps({"type": "assistant", "isSidechain": True,
                "message": {"role": "assistant", "content": [
                    {"type": "text", "text": "working on it"},
                    {"type": "tool_use", "name": "Bash",
                     "input": {"command": "ls -la"}}]}}) + "\n")
    # agent a2 (running): meta + jsonl, T2 has no tool_result in main
    with open(os.path.join(sub, "agent-a2.meta.json"), "w") as f:
        json.dump({"agentType": "Explore", "description": "second agent",
                   "toolUseId": "T2", "spawnDepth": 2}, f)
    with open(os.path.join(sub, "agent-a2.jsonl"), "w") as f:
        f.write(json.dumps({"type": "assistant", "isSidechain": True,
                "message": {"role": "assistant", "content": [
                    {"type": "text", "text": "still going"}]}}) + "\n")
    return root, sid


def test_session_agents_roster_and_status():
    root, sid = _fixture()
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        out = agents.session_agents({"claude_session_id": sid})
        assert out["total"] == 2
        assert out["running"] == 1                      # a2 running, a1 done
        by_id = {a["agent_id"]: a for a in out["agents"]}
        assert by_id["agent-a1"]["status"] == "done"
        assert by_id["agent-a1"]["description"] == "first agent"
        assert by_id["agent-a1"]["agent_type"] == "general-purpose"
        assert by_id["agent-a2"]["status"] == "running"
        assert by_id["agent-a2"]["spawn_depth"] == 2
    finally:
        transcript_jsonl.PROJECTS_DIR = orig


def test_session_agents_empty_when_no_dir():
    out = agents.session_agents({"claude_session_id": "nope-no-such-uuid"})
    assert out == {"running": 0, "total": 0, "agents": []}
    assert agents.session_agents({"claude_session_id": None})["total"] == 0


def test_agent_activity_parses_and_cursors():
    root, sid = _fixture()
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        act = agents.agent_activity({"claude_session_id": sid}, "agent-a1")
        kinds = [(e["type"], e.get("name") or e.get("text")) for e in act["events"]]
        assert ("text", "working on it") in kinds
        assert ("tool", "Bash") in kinds
        assert act["status"] == "done"
        assert act["agent_type"] == "general-purpose"
        assert act["next_cursor"] == 2                  # two records consumed
        # cursor skips already-seen records
        act2 = agents.agent_activity({"claude_session_id": sid}, "agent-a1",
                                     cursor=act["next_cursor"])
        assert act2["events"] == []
    finally:
        transcript_jsonl.PROJECTS_DIR = orig


def test_agent_activity_rejects_traversal():
    root, sid = _fixture()
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        act = agents.agent_activity({"claude_session_id": sid}, "../../etc/passwd")
        assert act["events"] == []
    finally:
        transcript_jsonl.PROJECTS_DIR = orig


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
    print("all passed")
