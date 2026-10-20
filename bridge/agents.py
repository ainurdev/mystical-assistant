"""Read-only view of the subagents a session spawned. Everything is derived from
the files Claude Code writes under ~/.claude/projects/<enc>/<sid>/subagents/.
Never writes; never touches the live run."""
import glob
import json
import os
import re
import threading

from bridge import machine, transcript_jsonl

_AGENT_ID_RE = re.compile(r"^agent-[A-Za-z0-9_]+$")
_RUN_ID_RE = re.compile(r"^wf_[A-Za-z0-9_-]+$")

# The main transcript's finish marks are re-read on every agents poll
# (1s/1.5s) to mark subagents done; memoize by (mtime, size) so a poll of an
# unchanged transcript is a stat, not a full read.
_completed_cache: "dict[str, tuple]" = {}   # main_path -> ((mtime, size), set)
_completed_lock = threading.Lock()
# The CLI ends a background agent with a <task-notification> user message naming
# its task id, and a SendMessage resume answers with the id it restarted.
_TASK_DONE_RE = re.compile(r"<task-id>([A-Za-z0-9_]+)</task-id>")
_RESUMED_RE = re.compile(r'"resumedAgentId"\s*:\s*"([A-Za-z0-9_]+)"')
# Each agent's own file is read once per change for the roster's numbers; a
# finished agent's file never changes again, so its poll is a stat.
_summary_cache: "dict[str, tuple]" = {}     # jsonl path -> ((mtime, size), summary)
_summary_lock = threading.Lock()


def _summary(path: str) -> dict:
    """What the roster says about one agent, off its own records: when it started
    and last wrote — the records' timestamps, since st_ctime is the inode-change
    time (= mtime) on macOS and Linux alike — its model, and how many tools it
    called."""
    try:
        st = os.stat(path)
    except OSError:
        return {"started_at": 0.0, "updated_at": 0.0, "model": None, "tools": 0}
    key = (st.st_mtime, st.st_size)
    with _summary_lock:
        ent = _summary_cache.get(path)
        if ent and ent[0] == key:
            return ent[1]
    first = last = 0.0
    model, tools = None, 0
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if ts := transcript_jsonl._ts(rec):
                    first, last = first or ts, ts
                msg = rec.get("message")
                if rec.get("type") == "assistant" and isinstance(msg, dict):
                    m = msg.get("model") or ""
                    if not model and m and not m.startswith("<"):   # "<synthetic>": an API error, no model
                        model = transcript_jsonl._short_model(m)
                    tools += sum(1 for b in msg.get("content") or []
                                 if isinstance(b, dict) and b.get("type") == "tool_use")
    except OSError:
        pass
    out = {"started_at": first or st.st_mtime, "updated_at": last or st.st_mtime,
           "model": model, "tools": tools}
    with _summary_lock:
        _summary_cache[path] = (key, out)
    return out


def _texts(content) -> list[str]:
    """The text of a message or tool_result content: a string, or its text blocks."""
    if isinstance(content, str):
        return [content]
    return [b.get("text") or "" for b in content or []
            if isinstance(b, dict) and b.get("type") == "text"]


def _finished(meta: dict, agent_id: str, marks: set[str]) -> bool:
    """A foreground agent is done when its tool_use has its tool_result. A
    background one gets that at launch ("Async agent launched"), so its mark is
    the task-notification the CLI appends when it ends (see _finished_marks)."""
    if meta.get("requestShape") == "background":
        return agent_id in marks
    tool_use_id = meta.get("toolUseId") or ""
    return bool(tool_use_id) and tool_use_id in marks


def _session_alive(session: dict) -> bool:
    """Is the Claude process that owns this session still up? A subagent is only
    'running' while its parent is: a killed / exited parent never writes the
    tool_result that would mark its agents done, so without this every abandoned
    fan-out reads "N agents working" forever."""
    sid = session.get("claude_session_id")
    return bool(sid) and sid in machine.live_session_ids()


def _subagents_dir(session: dict) -> str | None:
    sid = session.get("claude_session_id")
    if not sid:
        return None
    main = transcript_jsonl.find_transcript(sid)          # <enc>/<sid>.jsonl
    if not main:
        return None
    d = os.path.join(os.path.dirname(main), sid, "subagents")
    return d if os.path.isdir(d) else None


def _finished_marks(session: dict) -> set[str]:
    """What the main transcript says has finished: every tool_use id with a
    tool_result, plus the `agent-<id>` of every background agent whose last
    mark is a task-notification rather than a resume."""
    sid = session.get("claude_session_id")
    main = transcript_jsonl.find_transcript(sid) if sid else None
    if not main:
        return set()
    try:
        st = os.stat(main)
        key = (st.st_mtime, st.st_size)
    except OSError:
        return set()
    with _completed_lock:
        ent = _completed_cache.get(main)
        if ent and ent[0] == key:
            return ent[1]
    done: set[str] = set()
    try:
        with open(main, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
                content = msg.get("content")
                if rec.get("type") == "user":
                    for txt in _texts(content):
                        if "<task-notification>" in txt:
                            done.update("agent-" + t for t in _TASK_DONE_RE.findall(txt))
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            tid = b.get("tool_use_id")
                            if tid:
                                done.add(tid)
                            for txt in _texts(b.get("content")):
                                for aid in _RESUMED_RE.findall(txt):
                                    done.discard("agent-" + aid)
    except OSError:
        pass
    with _completed_lock:
        _completed_cache[main] = (key, done)
        if len(_completed_cache) > 64:
            for k in list(_completed_cache)[:len(_completed_cache) - 64]:
                _completed_cache.pop(k, None)
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


def _run_status(rec: dict, alive: bool = True) -> str:
    """A workflow is done once its record carries a terminal status; a missing
    record or an explicit "running" means it is still in flight — unless the
    session that hosts it is gone, in which case nothing is in flight."""
    raw = rec.get("status")
    return "done" if (raw and raw != "running") or not alive else "running"


def _session_workflows(subagents_dir: str, alive: bool = True) -> list[dict]:
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
        status = _run_status(rec, alive)
        sub: list[dict] = []
        for meta_path in glob.glob(os.path.join(run_dir, "*.meta.json")):
            agent_id = os.path.basename(meta_path)[:-len(".meta.json")]
            try:
                with open(meta_path, encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, json.JSONDecodeError):
                meta = {}
            sub.append({"agent_id": agent_id,
                        "agent_type": meta.get("agentType") or "workflow-subagent",
                        "description": meta.get("description") or "",
                        "run_id": run_id,
                        "status": status,          # sub-agents mirror the run
                        **_summary(os.path.join(run_dir, agent_id + ".jsonl"))})
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
    marks = _finished_marks(session)
    alive = _session_alive(session)
    out: list[dict] = []
    for meta_path in glob.glob(os.path.join(d, "*.meta.json")):
        try:
            with open(meta_path, encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        agent_id = os.path.basename(meta_path)[:-len(".meta.json")]
        tool_use_id = meta.get("toolUseId") or ""
        status = "done" if _finished(meta, agent_id, marks) or not alive else "running"
        out.append({"agent_id": agent_id,
                    "agent_type": meta.get("agentType") or "agent",
                    "description": meta.get("description") or "",
                    "tool_use_id": tool_use_id,
                    "spawn_depth": meta.get("spawnDepth") or 1,
                    "status": status,
                    **_summary(os.path.join(d, agent_id + ".jsonl"))})
    out.sort(key=lambda a: a["started_at"])
    workflows = _session_workflows(d, alive)
    wf_agents = [a for w in workflows for a in w["agents"]]
    return {"running": sum(1 for a in out if a["status"] == "running")
                       + sum(1 for a in wf_agents if a["status"] == "running"),
            "total": len(out) + len(wf_agents),
            "agents": out, "workflows": workflows}


def agent_activity(session: dict, agent_id: str, cursor: int = 0,
                   workflow_id: str | None = None) -> dict:
    """One agent's run in the transcript's own shape ({turns, events, next_cursor},
    transcript_jsonl.parse_jsonl over its sidechain file): its brief is the turn's
    prompt and its calls carry their results, so the dashboard draws it with the
    chat's renderer. `cursor` is the event seq, as for a session."""
    empty = {"turns": [], "events": [], "next_cursor": cursor, "status": "done",
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
    if not os.path.isfile(jsonl):
        return empty
    meta = {}
    try:
        with open(os.path.join(base, agent_id + ".meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, json.JSONDecodeError):
        pass
    run = transcript_jsonl.parse_jsonl(jsonl, cursor, sidechain=True)
    alive = _session_alive(session)
    if workflow_id:                                       # status follows the run
        status = _run_status(_workflow_records(d).get(workflow_id, {}), alive)
    else:
        status = ("done" if _finished(meta, agent_id, _finished_marks(session)) or not alive
                  else "running")
    return {**run, "status": status,
            "description": meta.get("description") or "",
            "agent_type": meta.get("agentType") or "agent"}
