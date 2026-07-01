"""Read-only view of the subagents a session spawned. Everything is derived from
the files Claude Code writes under ~/.claude/projects/<enc>/<sid>/subagents/.
Never writes; never touches the live run."""
import glob
import json
import os
import re

from bridge import transcript_jsonl

_AGENT_ID_RE = re.compile(r"^agent-[A-Za-z0-9_]+$")


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


def session_agents(session: dict) -> dict:
    d = _subagents_dir(session)
    if not d:
        return {"running": 0, "total": 0, "agents": []}
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
    return {"running": sum(1 for a in out if a["status"] == "running"),
            "total": len(out), "agents": out}


def agent_activity(session: dict, agent_id: str, cursor: int = 0) -> dict:
    empty = {"events": [], "next_cursor": cursor, "status": "done",
             "description": "", "agent_type": ""}
    if not _AGENT_ID_RE.match(agent_id or ""):
        return empty
    d = _subagents_dir(session)
    if not d:
        return empty
    jsonl = os.path.join(d, agent_id + ".jsonl")
    if os.path.dirname(os.path.realpath(jsonl)) != os.path.realpath(d):
        return empty                                      # traversal guard
    meta = {}
    try:
        with open(os.path.join(d, agent_id + ".meta.json"), encoding="utf-8") as fh:
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
    tool_use_id = meta.get("toolUseId") or ""
    status = ("done" if tool_use_id and tool_use_id in _completed_tool_use_ids(session)
              else "running")
    return {"events": events, "next_cursor": idx, "status": status,
            "description": meta.get("description") or "",
            "agent_type": meta.get("agentType") or "agent"}
