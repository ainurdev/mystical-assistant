"""Read-only view of the subagents a session spawned. Everything is derived from
the files Claude Code writes under ~/.claude/projects/<enc>/<sid>/subagents/.
Never writes; never touches the live run."""
import glob
import json
import os
import re

from bridge import transcript_jsonl

_AGENT_ID_RE = re.compile(r"^agent-[A-Za-z0-9_]+$")
_RUN_ID_RE = re.compile(r"^wf_[A-Za-z0-9_-]+$")


def _subagents_dir(session: dict) -> str | None:
    sid = session.get("claude_session_id")
    if not sid:
        return None
    main = transcript_jsonl.find_transcript(sid)          # <enc>/<sid>.jsonl
    if not main:
        return None
    d = os.path.join(os.path.dirname(main), sid, "subagents")
    return d if os.path.isdir(d) else None


def _completed_tool_use_ids(session: dict) -> set[str]:
    sid = session.get("claude_session_id")
    main = transcript_jsonl.find_transcript(sid) if sid else None
    done: set[str] = set()
    if not main:
        return done
    try:
        with open(main, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
                content = msg.get("content")
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            tid = b.get("tool_use_id")
                            if tid:
                                done.add(tid)
    except OSError:
        pass
    return done


def _workflow_records(subagents_dir: str) -> dict:
    """Read <sid>/workflows/wf_*.json run records → {run_id: record}. Written by
    the Workflow tool alongside (a sibling of) the subagents dir."""
    out: dict = {}
    d = os.path.join(os.path.dirname(subagents_dir), "workflows")
    for p in glob.glob(os.path.join(d, "wf_*.json")):
        rid = os.path.basename(p)[:-len(".json")]
        if not _RUN_ID_RE.match(rid):
            continue
        try:
            with open(p, encoding="utf-8") as fh:
                out[rid] = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
    return out


def _run_status(rec: dict) -> str:
    """A workflow is done once its record carries a terminal status; a missing
    record or an explicit "running" means it is still in flight."""
    raw = rec.get("status")
    return "done" if raw and raw != "running" else "running"


def _session_workflows(subagents_dir: str) -> list[dict]:
    """Group Workflow-spawned sub-agents (subagents/workflows/<run>/) by run,
    enriched with the run record. Ordered by first sub-agent start."""
    wf_root = os.path.join(subagents_dir, "workflows")
    if not os.path.isdir(wf_root):
        return []
    records = _workflow_records(subagents_dir)
    out: list[dict] = []
    for run_id in os.listdir(wf_root):
        run_dir = os.path.join(wf_root, run_id)
        if not (_RUN_ID_RE.match(run_id) and os.path.isdir(run_dir)):
            continue
        rec = records.get(run_id, {})
        status = _run_status(rec)
        sub: list[dict] = []
        for meta_path in glob.glob(os.path.join(run_dir, "*.meta.json")):
            agent_id = os.path.basename(meta_path)[:-len(".meta.json")]
            try:
                with open(meta_path, encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, json.JSONDecodeError):
                meta = {}
            try:
                st = os.stat(os.path.join(run_dir, agent_id + ".jsonl"))
                started, updated = st.st_ctime, st.st_mtime
            except OSError:
                started = updated = 0.0
            sub.append({"agent_id": agent_id,
                        "agent_type": meta.get("agentType") or "workflow-subagent",
                        "description": meta.get("description") or "",
                        "run_id": run_id,
                        "status": status,          # sub-agents mirror the run
                        "started_at": started, "updated_at": updated})
        sub.sort(key=lambda a: a["started_at"])
        out.append({"run_id": run_id,
                    "name": rec.get("workflowName") or run_id,
                    "status": status,
                    "agent_count": rec.get("agentCount") or len(sub),
                    "total_tokens": rec.get("totalTokens") or 0,
                    "total_tool_calls": rec.get("totalToolCalls") or 0,
                    "duration_ms": rec.get("durationMs") or 0,
                    "summary": rec.get("summary") or "",
                    "agents": sub})
    out.sort(key=lambda w: w["agents"][0]["started_at"] if w["agents"] else 0.0)
    return out


def session_agents(session: dict) -> dict:
    d = _subagents_dir(session)
    if not d:
        return {"running": 0, "total": 0, "agents": [], "workflows": []}
    done_ids = _completed_tool_use_ids(session)
    out: list[dict] = []
    for meta_path in glob.glob(os.path.join(d, "*.meta.json")):
        try:
            with open(meta_path, encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        agent_id = os.path.basename(meta_path)[:-len(".meta.json")]
        tool_use_id = meta.get("toolUseId") or ""
        status = "done" if tool_use_id and tool_use_id in done_ids else "running"
        try:
            st = os.stat(os.path.join(d, agent_id + ".jsonl"))
            started, updated = st.st_ctime, st.st_mtime
        except OSError:
            started = updated = 0.0
        out.append({"agent_id": agent_id,
                    "agent_type": meta.get("agentType") or "agent",
                    "description": meta.get("description") or "",
                    "tool_use_id": tool_use_id,
                    "spawn_depth": meta.get("spawnDepth") or 1,
                    "status": status,
                    "started_at": started, "updated_at": updated})
    out.sort(key=lambda a: a["started_at"])
    workflows = _session_workflows(d)
    wf_agents = [a for w in workflows for a in w["agents"]]
    return {"running": sum(1 for a in out if a["status"] == "running")
                       + sum(1 for a in wf_agents if a["status"] == "running"),
            "total": len(out) + len(wf_agents),
            "agents": out, "workflows": workflows}


def agent_activity(session: dict, agent_id: str, cursor: int = 0,
                   workflow_id: str | None = None) -> dict:
    empty = {"events": [], "next_cursor": cursor, "status": "done",
             "description": "", "agent_type": ""}
    if not _AGENT_ID_RE.match(agent_id or ""):
        return empty
    d = _subagents_dir(session)
    if not d:
        return empty
    if workflow_id:                                       # Workflow-spawned sub-agent
        if not _RUN_ID_RE.match(workflow_id):
            return empty
        base = os.path.join(d, "workflows", workflow_id)
    else:
        base = d
    jsonl = os.path.join(base, agent_id + ".jsonl")
    if os.path.dirname(os.path.realpath(jsonl)) != os.path.realpath(base):
        return empty                                      # traversal guard
    meta = {}
    try:
        with open(os.path.join(base, agent_id + ".meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, json.JSONDecodeError):
        pass
    events: list[dict] = []
    idx = 0
    try:
        with open(jsonl, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                if idx < cursor:
                    idx += 1
                    continue
                idx += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") != "assistant":        # feed = what the agent did
                    continue
                msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
                for b in msg.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text":
                        txt = (b.get("text") or "").strip()
                        if txt:
                            events.append({"type": "text", "text": txt})
                    elif b.get("type") == "tool_use":
                        name = b.get("name", "tool")
                        events.append({"type": "tool", "name": name,
                                       "summary": transcript_jsonl._summarize_tool(
                                           name, b.get("input", {}))})
    except OSError:
        return empty
    if workflow_id:                                       # status follows the run
        status = _run_status(_workflow_records(d).get(workflow_id, {}))
    else:
        tool_use_id = meta.get("toolUseId") or ""
        status = ("done" if tool_use_id and tool_use_id in _completed_tool_use_ids(session)
                  else "running")
    return {"events": events, "next_cursor": idx, "status": status,
            "description": meta.get("description") or "",
            "agent_type": meta.get("agentType") or "agent"}
