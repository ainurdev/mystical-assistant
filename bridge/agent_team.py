"""A chat's Claude sub-agents as a team: who started whom, what each is doing, and what they said.

For the Agents view (dashboard components/AgentsView). bridge/agents.py already lists a session's
sub-agents flat, for the sidebar. A run with 100 of them, three levels deep, needs more: the tree
(meta.parentAgentId), a line on what each is doing now, the conversation between them, and one agent's
recent work with its edits as diffs. All of it is read from the files Claude Code writes under
<session>/subagents/, never from the main chat's transcript: sub-agents' steps no longer go there
(runner._handle_event), which is what made a 100-agent turn 7,500 rows long.

Cost is the design constraint. That run's files were 450 MB, a busy one 40 MB and growing, and the view
polls. So each file is read once and then only its new bytes (_scan keeps an offset), and a record is
parsed only when it's an assistant's: tool results, which are most of the bytes, are skipped on a
substring. One agent's detail reads the file's tail, not the file.

The conversation is what agents were told and what they said back: a brief (the Agent tool's prompt), a
message (SendMessage), a report (SubagentHandback, or a foreground agent's last words), a problem (an
agent that ended on an API error), and what you typed to the main agent.

ponytail: nothing here can message or stop one sub-agent. Claude Code gives that to the main agent
(SendMessage, TaskStop), so the view asks the main agent to do it, in words, at its next step.

Never writes. Stdlib only.
"""

import json
import os
import threading
import time
from datetime import datetime

from bridge import agents, transcript_jsonl

MAIN = "main"
TAIL_BYTES = 600_000
MAX_STEPS = 60
MAX_TEXT = 6000
DIFF_LINES = 14
IDLE_DONE_S = 180
_scans: dict = {}
_lock = threading.Lock()


def _ts(value) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text") or "" for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def _say(name: str, inp: dict) -> str:
    """A step in a few words: what a person would say the agent did."""
    path = str(inp.get("file_path") or inp.get("path") or inp.get("notebook_path") or "")
    short = os.path.basename(path) or path
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"Edited {short}"
    if name == "Write":
        return f"Wrote {short}"
    if name == "Read":
        return f"Read {short}"
    if name == "Bash":
        return "Ran " + " ".join(str(inp.get("description") or inp.get("command") or "").split())[:140]
    if name in ("Grep", "Glob"):
        return f"Searched for {str(inp.get('pattern') or '')[:80]}"
    if name in ("Agent", "Task"):
        return f"Started an agent: {str(inp.get('description') or '')[:80]}"
    if name == "SendMessage":
        return f"Sent a message: {str(inp.get('summary') or inp.get('message') or '')[:80]}"
    if name == "SubagentHandback":
        return "Reported back"
    return name.replace("mcp__", "").replace("__", " ")


def _new_state() -> dict:
    return {"offset": 0, "first": 0.0, "last": 0.0, "tools": 0, "model": None, "now": "", "now_at": 0.0, "messages": [],
            "final": "", "final_at": 0.0, "ended": False, "error": False, "handback": False, "brief": "", "n": 0}


def _feed(st: dict, rec: dict, who: str) -> None:
    at = _ts(rec.get("timestamp"))
    if at:
        st["first"] = st["first"] or at
        st["last"] = max(st["last"], at)
    msg = rec.get("message") or {}
    kind = rec.get("type")
    if kind == "user":
        content = msg.get("content")
        text = _text_of(content).strip() if not (isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content)) else ""
        if text and not st["n"] and who != MAIN:
            st["brief"] = text[:MAX_TEXT]
        elif text and who == MAIN and not rec.get("isMeta") and not rec.get("isSidechain") and not text.startswith(("<", "[Request interrupted", "⧖", "⏮", "⇄", "[goal]")):
            st["messages"].append({"at": at, "kind": "you", "from": "you", "to": MAIN, "text": text[:MAX_TEXT]})
        st["n"] += 1
        return
    if kind != "assistant":
        return
    st["n"] += 1
    model = msg.get("model")
    if model and not str(model).startswith("<"):
        st["model"] = transcript_jsonl._short_model(model)     # noqa: SLF001 - the roster's own short names
    st["error"] = bool(rec.get("isApiErrorMessage"))
    said = ""
    for b in msg.get("content") or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text" and (b.get("text") or "").strip():
            said = b["text"].strip()
        if b.get("type") != "tool_use":
            continue
        st["tools"] += 1
        name, inp = b.get("name") or "tool", b.get("input") if isinstance(b.get("input"), dict) else {}
        st["now"], st["now_at"] = _say(name, inp), at
        if name in ("Agent", "Task"):
            st["messages"].append({"at": at, "kind": "brief", "from": who, "tool_use": b.get("id"),
                                   "title": str(inp.get("description") or "")[:200], "text": str(inp.get("prompt") or "")[:MAX_TEXT]})
        elif name == "SendMessage":
            st["messages"].append({"at": at, "kind": "message", "from": who, "to_raw": str(inp.get("to") or ""),
                                   "title": str(inp.get("summary") or "")[:200], "text": str(inp.get("message") or "")[:MAX_TEXT]})
        elif name == "SubagentHandback":
            st["handback"] = True
            st["messages"].append({"at": at, "kind": "report", "from": who, "text": str(inp.get("message") or "")[:MAX_TEXT]})
    if said:
        st["final"], st["final_at"] = said[:MAX_TEXT], at
    st["ended"] = msg.get("stop_reason") == "end_turn"


def _scan(path: str, who: str) -> dict:
    """What a transcript file says so far. Reads only what's new since the last look."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return _new_state()
    with _lock:
        st = _scans.get(path)
        if st is None or size < st["offset"]:
            st = _scans[path] = _new_state()
        if size == st["offset"]:
            return st
        try:
            with open(path, "rb") as f:
                f.seek(st["offset"])
                data = f.read()
        except OSError:
            return st
        end = data.rfind(b"\n")
        if end < 0:
            return st
        for raw in data[:end].split(b"\n"):
            # A tool result is most of a file's bytes and tells this view nothing: skipped unparsed.
            if not raw or (b'"tool_result"' in raw[:4000] and st["n"]) or b'"type":"' not in raw:
                if raw:
                    st["n"] += 1
                continue
            if who == MAIN and b'"isSidechain":true' in raw[:400]:
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if isinstance(rec, dict):
                _feed(st, rec, who)
        st["offset"] += end + 1
        return st


def _metas(d: str) -> dict:
    out = {}
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".meta.json"):
            continue
        try:
            with open(os.path.join(d, name), encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(meta, dict):
            out[name[:-len(".meta.json")]] = meta
    return out


def _status(meta: dict, aid: str, st: dict, marks: set, alive: bool, now: float) -> str:
    if st["error"] and (st["ended"] or not alive or agents._finished(meta, aid, marks)):   # noqa: SLF001
        return "failed"
    if not alive or agents._finished(meta, aid, marks):                                      # noqa: SLF001
        return "done"
    # Said its last words a while ago and nothing since: an older CLI that writes no finish mark.
    if st["ended"] and st["last"] and now - st["last"] > IDLE_DONE_S:
        return "done"
    return "running"


def team(session: dict) -> dict:
    """{agents, messages, counts}: the tree as a flat list with parents, and the conversation, oldest first."""
    main_path = transcript_jsonl.find_transcript(session.get("claude_session_id") or "") if session.get("claude_session_id") else None
    d = agents._subagents_dir(session)                                                       # noqa: SLF001
    if not main_path or not d:
        return {"agents": [], "messages": [], "counts": {}, "main": None}
    metas, marks, alive, now = _metas(d), agents._finished_marks(session), agents._session_alive(session), time.time()   # noqa: SLF001
    by_tool = {m.get("toolUseId"): aid for aid, m in metas.items() if m.get("toolUseId")}
    name_of = {aid: (m.get("description") or m.get("agentType") or "agent") for aid, m in metas.items()}
    rows, messages = [], []
    main = _scan(main_path, MAIN)
    for aid, meta in metas.items():
        st = _scan(os.path.join(d, aid + ".jsonl"), aid)
        parent = f"agent-{meta['parentAgentId']}" if meta.get("parentAgentId") else MAIN
        status = _status(meta, aid, st, marks, alive, now)
        rows.append({"id": aid, "name": name_of[aid], "type": meta.get("agentType") or "agent", "parent": parent if parent in metas else MAIN,
                     "depth": int(meta.get("spawnDepth") or 1), "status": status, "started": st["first"], "updated": st["last"],
                     "model": st["model"], "tools": st["tools"], "now": st["now"] if status == "running" else "", "background": meta.get("requestShape") == "background"})
        for m in st["messages"]:
            messages.append(dict(m))
        if status in ("done", "failed") and not st["handback"] and st["final"]:
            messages.append({"at": st["final_at"] or st["last"], "kind": "problem" if status == "failed" else "report", "from": aid, "text": st["final"]})
    messages += [dict(m) for m in main["messages"]]
    parent_of = {r["id"]: r["parent"] for r in rows}
    for m in messages:
        if m["kind"] == "brief":
            m["to"] = by_tool.get(m.pop("tool_use", None)) or ""
        elif m["kind"] == "message":
            raw = m.pop("to_raw", "")
            m["to"] = raw if raw in metas else f"agent-{raw}" if f"agent-{raw}" in metas else MAIN if raw in ("main", "lead", "") else raw
        elif m["kind"] in ("report", "problem"):
            m["to"] = parent_of.get(m["from"], MAIN)
    messages = [m for m in messages if m.get("to") or m["kind"] != "brief"]
    messages.sort(key=lambda m: m["at"])
    running_kids = {}
    for r in rows:
        if r["status"] == "running":
            running_kids[r["parent"]] = running_kids.get(r["parent"], 0) + 1
    for r in rows:
        # Working, but all it's doing is waiting for the agents it started.
        if r["status"] == "running" and running_kids.get(r["id"]) and now - (r["updated"] or now) > 45:
            r["status"], r["now"] = "waiting", f"Waiting for {running_kids[r['id']]} agent{'s' if running_kids[r['id']] != 1 else ''}"
    rows.sort(key=lambda r: r["started"] or 0)
    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    main_row = {"id": MAIN, "name": "Main agent", "status": "running" if alive else "done", "started": main["first"], "updated": main["last"],
                "tools": main["tools"], "model": main["model"], "now": (f"Waiting for {running_kids[MAIN]} agent{'s' if running_kids[MAIN] != 1 else ''}"
                                                                         if running_kids.get(MAIN) and now - (main["last"] or now) > 45 else main["now"]) if alive else ""}
    return {"agents": rows, "messages": messages[-400:], "counts": counts, "main": main_row, "names": {**name_of, MAIN: "Main agent"},
            "depth": max((r["depth"] for r in rows), default=0)}


def _diff(name: str, inp: dict) -> "dict | None":
    """An edit as lines to draw, from what the tool was given: the result's own patch isn't in a sub-agent's file."""
    path = str(inp.get("file_path") or inp.get("notebook_path") or "")
    pairs = []
    if name == "Edit":
        pairs = [(str(inp.get("old_string") or ""), str(inp.get("new_string") or ""))]
    elif name == "MultiEdit":
        pairs = [(str(e.get("old_string") or ""), str(e.get("new_string") or "")) for e in inp.get("edits") or [] if isinstance(e, dict)]
    elif name == "Write":
        pairs = [("", str(inp.get("content") or ""))]
    else:
        return None
    lines, added, removed = [], 0, 0
    for old, new in pairs:
        olds, news = (old.splitlines() if old else []), (new.splitlines() if new else [])
        # What both sides start and end with is context, not change.
        head = 0
        while head < min(len(olds), len(news)) and olds[head] == news[head]:
            head += 1
        tail = 0
        while tail < min(len(olds), len(news)) - head and olds[-1 - tail] == news[-1 - tail]:
            tail += 1
        gone, came = olds[head:len(olds) - tail], news[head:len(news) - tail]
        removed, added = removed + len(gone), added + len(came)
        if head:
            lines.append({"k": "c", "t": olds[head - 1][:240]})
        lines += [{"k": "r", "t": x[:240]} for x in gone] + [{"k": "a", "t": x[:240]} for x in came]
        if tail:
            lines.append({"k": "c", "t": olds[len(olds) - tail][:240]})
    more = max(0, len(lines) - DIFF_LINES)
    return {"path": path, "added": added, "removed": removed, "lines": lines[:DIFF_LINES], "more": more, "new": name == "Write"}


def _tail_records(path: str) -> list:
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - TAIL_BYTES))
            data = f.read()
    except OSError:
        return []
    if size > TAIL_BYTES:
        data = data[data.find(b"\n") + 1:]
    out = []
    for raw in data.split(b"\n"):
        if not raw or b'"type":"assistant"' not in raw:
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("type") == "assistant":
            out.append(rec)
    return out


def agent(session: dict, aid: str) -> "dict | None":
    """One agent up close: its brief, its last steps with edits as diffs, and its report."""
    main_path = transcript_jsonl.find_transcript(session.get("claude_session_id") or "") if session.get("claude_session_id") else None
    d = agents._subagents_dir(session)                                                       # noqa: SLF001
    if not main_path:
        return None
    if aid == MAIN:
        path, who = main_path, MAIN
    else:
        if not d or not agents._AGENT_ID_RE.match(aid or ""):                                # noqa: SLF001
            return None
        path, who = os.path.join(d, aid + ".jsonl"), aid
        if not os.path.isfile(path):
            return None
    st = _scan(path, who)
    steps = []
    for rec in _tail_records(path):
        if who == MAIN and rec.get("isSidechain"):
            continue
        at = _ts(rec.get("timestamp"))
        for b in (rec.get("message") or {}).get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and (b.get("text") or "").strip():
                steps.append({"at": at, "kind": "say", "text": b["text"].strip()[:1200]})
            elif b.get("type") == "tool_use":
                name, inp = b.get("name") or "tool", b.get("input") if isinstance(b.get("input"), dict) else {}
                step = {"at": at, "kind": "edit" if name in ("Edit", "MultiEdit", "Write", "NotebookEdit") else "run" if name == "Bash" else
                        "agent" if name in ("Agent", "Task") else "message" if name in ("SendMessage", "SubagentHandback") else "read", "text": _say(name, inp)}
                if name == "Bash":
                    step["detail"] = str(inp.get("command") or "")[:1500]
                diff = _diff(name, inp)
                if diff:
                    step["diff"] = diff
                steps.append(step)
    report = next((m["text"] for m in reversed(st["messages"]) if m["kind"] == "report"), "") or (st["final"] if st["ended"] else "")
    return {"id": aid, "brief": st["brief"], "steps": steps[-MAX_STEPS:], "earlier": max(0, st["tools"] - sum(1 for s in steps[-MAX_STEPS:] if s["kind"] != "say")),
            "report": report, "tools": st["tools"], "started": st["first"], "updated": st["last"], "model": st["model"]}
