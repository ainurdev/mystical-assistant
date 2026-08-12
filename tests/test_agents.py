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

from bridge import agents, machine, transcript_jsonl  # noqa: E402


def _register(sid, alive=True):
    """Write a Claude session-registry entry for `sid` (conftest points
    machine.SESSIONS_DIR at an empty temp dir). Agents only count as running while
    their parent process does, so a live pid is part of the fixture. Fresh dir per
    fixture so one test's live entry can't leak into the next test's dead one."""
    machine.SESSIONS_DIR = tempfile.mkdtemp()
    pid = os.getpid() if alive else 2 ** 22   # >/proc/sys/kernel/pid_max → dead
    with open(os.path.join(machine.SESSIONS_DIR, f"{pid}.json"), "w") as f:
        json.dump({"pid": pid, "sessionId": sid, "cwd": "/tmp/proj",
                   "entrypoint": "sdk-cli"}, f)


def _fixture(alive=True):
    """Build ~/.claude/projects-style tree: main transcript + 2 subagents.
    agent a1's Task (T1) has a tool_result in main → done; a2 (T2) → running."""
    root = tempfile.mkdtemp()
    sid = "11111111-2222-3333-4444-555555555555"
    _register(sid, alive)
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
    assert out == {"running": 0, "total": 0, "agents": [], "workflows": []}
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


def _add_workflow(root, sid, run_id="wf_test1", status="completed", n_agents=1):
    """Add a Workflow run to the fixture tree: sub-agents under
    subagents/workflows/<run_id>/ + a run record under workflows/<run_id>.json."""
    proj = os.path.join(root, "-tmp-proj")
    run_dir = os.path.join(proj, sid, "subagents", "workflows", run_id)
    os.makedirs(run_dir, exist_ok=True)
    for i in range(n_agents):
        aid = f"agent-w{i + 1}"
        with open(os.path.join(run_dir, aid + ".meta.json"), "w") as f:
            json.dump({"agentType": "workflow-subagent"}, f)
        with open(os.path.join(run_dir, aid + ".jsonl"), "w") as f:
            f.write(json.dumps({"type": "assistant", "isSidechain": True,
                    "message": {"role": "assistant", "content": [
                        {"type": "text", "text": "wf agent working"},
                        {"type": "tool_use", "name": "Grep",
                         "input": {"pattern": "x"}}]}}) + "\n")
    recs = os.path.join(proj, sid, "workflows")
    os.makedirs(recs, exist_ok=True)
    rec = {"runId": run_id, "workflowName": "hunt", "agentCount": n_agents,
           "totalTokens": 1234, "totalToolCalls": 7, "durationMs": 5000,
           "summary": "find the bug"}
    if status is not None:
        rec["status"] = status
    with open(os.path.join(recs, run_id + ".json"), "w") as f:
        json.dump(rec, f)


def test_session_agents_includes_workflows():
    root, sid = _fixture()
    _add_workflow(root, sid, n_agents=2)
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        out = agents.session_agents({"claude_session_id": sid})
        assert len(out["workflows"]) == 1
        wf = out["workflows"][0]
        assert wf["run_id"] == "wf_test1"
        assert wf["name"] == "hunt"
        assert wf["status"] == "done"                    # record status completed
        assert wf["agent_count"] == 2
        assert wf["total_tokens"] == 1234
        assert wf["total_tool_calls"] == 7
        assert wf["summary"] == "find the bug"
        assert sorted(a["agent_id"] for a in wf["agents"]) == ["agent-w1", "agent-w2"]
        assert wf["agents"][0]["run_id"] == "wf_test1"
        # regular agents untouched; total counts workflow sub-agents too (2 + 2)
        assert len(out["agents"]) == 2
        assert out["total"] == 4
    finally:
        transcript_jsonl.PROJECTS_DIR = orig


def test_workflow_running_when_status_absent():
    root, sid = _fixture()
    _add_workflow(root, sid, run_id="wf_run1", status=None)
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        out = agents.session_agents({"claude_session_id": sid})
        wf = {w["run_id"]: w for w in out["workflows"]}["wf_run1"]
        assert wf["status"] == "running"
        assert wf["agents"][0]["status"] == "running"    # sub-agents mirror the run
        assert out["running"] == 2                        # a2 (regular) + 1 wf sub-agent
    finally:
        transcript_jsonl.PROJECTS_DIR = orig


def test_agent_activity_reads_workflow_subagent():
    root, sid = _fixture()
    _add_workflow(root, sid)
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        act = agents.agent_activity({"claude_session_id": sid}, "agent-w1",
                                    workflow_id="wf_test1")
        kinds = [(e["type"], e.get("name") or e.get("text")) for e in act["events"]]
        assert ("text", "wf agent working") in kinds
        assert ("tool", "Grep") in kinds
        assert act["status"] == "done"                    # parent workflow completed
    finally:
        transcript_jsonl.PROJECTS_DIR = orig


def test_agent_activity_workflow_rejects_bad_run_id():
    root, sid = _fixture()
    _add_workflow(root, sid)
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        act = agents.agent_activity({"claude_session_id": sid}, "agent-w1",
                                    workflow_id="../../etc")
        assert act["events"] == []
    finally:
        transcript_jsonl.PROJECTS_DIR = orig


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
    print("all passed")


def test_agents_are_done_when_the_session_process_is_gone():
    """The bug behind "N agents working" on a finished session: a killed parent
    never writes the tool_result that marks its agents done, so without a
    liveness check the pill claims work that stopped hours ago."""
    root, sid = _fixture(alive=False)
    _add_workflow(root, sid, run_id="wf_dead", status=None)
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        out = agents.session_agents({"claude_session_id": sid})
        assert out["running"] == 0
        assert {a["status"] for a in out["agents"]} == {"done"}
        assert out["workflows"][0]["status"] == "done"   # no record status, dead host
        act = agents.agent_activity({"claude_session_id": sid}, "agent-a2")
        assert act["status"] == "done"
    finally:
        transcript_jsonl.PROJECTS_DIR = orig
