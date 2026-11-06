"""Every agent working under a chat, for the sidebar's tree and the grid.

Three kinds, one row shape:
  - member: a helper Mystical started (bridge/channel.py). Full detail: it's a session.
  - subagent: Claude's own Agent-tool subagents and workflows (bridge/agents.py reads
    them from Claude's files). Full detail.
  - opaque: another provider's own sub-agents. Kimi Code keeps one folder per agent
    under its session, `agents/<name>/wire.jsonl`, in its own private format. So the
    row says one exists and when it last moved, and `detail: false` makes the UI say
    so plainly instead of pretending to know more. No Kimi sub-agent has been seen in
    use yet (none in 37 real turns), so this is built from the folder layout alone.

Sorting and the three-row fold are the client's: it holds the user's sort, and the
order changes as often as the status does. Read per poll, so nothing here starts a
process, and a Claude session's scan is agents.py's own, memoized by file stamp.
"""

import glob
import os
import sys

from bridge import agents, handoff, profiles, store

_KIMI_HOME = "~/.kimi-code"
_RECENT_S = 120
MAX_IDS = 40


def _member_row(m: dict) -> dict:
    from bridge import runner
    info = store.parse_member(m.get("member")) or {}
    job = runner.live_job(m["id"])
    state = "running" if job is not None else (info.get("state") or "done")
    if state == "running" and job is None:
        state = "done"
    eff = profiles.effective(m)
    pending = list(job.pending) if job is not None else []
    return {"key": m["id"], "kind": "member", "name": m.get("title") or info.get("name") or "helper",
            "provider": handoff.label(eff["agent"]), "account": eff["account"], "model": eff["model"],
            "status": state, "needs": bool(pending), "detail": True, "session_id": m["id"],
            "started": info.get("started") or m.get("created"), "updated": m.get("updated"),
            "write": bool(info.get("write")), "brief": (info.get("brief") or "")[:300],
            "conflict": bool(info.get("conflict")), "merged": bool(info.get("merged")),
            # What's on disk: merging or discarding removes the copy, and undoing a merge
            # doesn't bring it back.
            "has_copy": os.path.isdir((info.get("copy") or {}).get("path") or ""),
            "activity": _activity(job)}


def main_row(chat: dict) -> dict:
    """The chat's main agent, in the same shape, for the grid's first card."""
    from bridge import runner
    job = runner.live_job(chat["id"])
    eff = profiles.effective(chat)
    return {"key": chat["id"], "kind": "main", "name": "main", "provider": handoff.label(eff["agent"]),
            "account": eff["account"], "model": eff["model"], "status": "running" if job else "idle",
            "needs": bool(job and job.pending), "detail": True, "session_id": chat["id"],
            "started": job.started if job else None, "updated": chat.get("updated"),
            "activity": _activity(job)}


def _activity(job) -> str:
    """The latest thing a running agent said or did, in a line."""
    if job is None:
        return ""
    try:
        for ev in reversed(list(job.events)[-30:]):
            if ev.get("type") == "text" and ev.get("text"):
                return " ".join(ev["text"].split())[:160]
            if ev.get("type") == "tool":
                return f"{ev.get('name') or 'tool'} {str(ev.get('summary') or '')[:120]}".strip()
    except Exception:  # noqa: BLE001 - a line of status
        pass
    return ""


def _subagent_rows(s: dict, owner_name: str) -> list:
    """Claude's own subagents of this session and their workflows."""
    if not s.get("claude_session_id"):
        return []
    try:
        data = agents.session_agents(s)
    except Exception as e:  # noqa: BLE001
        print(f"[agent_tree] {e!r}", file=sys.stderr)
        return []
    rows = []

    def add(a: dict, run: "str | None") -> None:
        rows.append({"key": f"{s['id']}:{run + '::' if run else ''}{a.get('agent_id')}", "kind": "subagent",
                     "name": a.get("description") or a.get("agent_type") or "subagent",
                     "provider": "Claude", "model": a.get("model"), "status": a.get("status") or "done",
                     "needs": False, "detail": True, "session_id": s["id"], "agent_id": a.get("agent_id"),
                     "workflow": run, "started": a.get("started_at"), "updated": a.get("updated_at"),
                     "owner": owner_name, "activity": ""})
    for a in data.get("agents") or []:
        add(a, None)
    for w in data.get("workflows") or []:
        for a in w.get("agents") or []:
            add(a, w.get("run_id"))
    return rows


def _opaque_rows(s: dict, owner_name: str) -> list:
    """An agent's own sub-agents: only that they exist."""
    native = s.get("agent_session_id")
    if not native or profiles.effective(s)["agent"] != "kimi":
        return []
    home = os.path.expanduser(os.environ.get("KIMI_CODE_HOME") or _KIMI_HOME)
    rows = []
    for path in glob.glob(os.path.join(glob.escape(home), "sessions", "*", glob.escape(native), "agents", "*")):
        name = os.path.basename(path)
        if name == "main":
            continue
        try:
            at = os.path.getmtime(path)
        except OSError:
            continue
        import time
        rows.append({"key": f"{s['id']}:opaque:{name}", "kind": "opaque", "name": name,
                     "provider": "Kimi Code", "status": "running" if time.time() - at < _RECENT_S else "unknown",
                     "needs": False, "detail": False, "started": at, "updated": at,
                     "owner": owner_name, "activity": ""})
    return rows


def tree(chat: dict) -> list:
    """All the agents under this chat: helpers, and everyone's own subagents."""
    rows = []
    members = store.members_of(chat["id"])
    for m in members:
        rows.append(_member_row(m))
    for s in [chat, *members]:
        owner = "main" if s["id"] == chat["id"] else (s.get("title") or "helper")
        rows += _subagent_rows(s, owner)
        rows += _opaque_rows(s, owner)
    return rows


def trees(ids: list, chat_id: int) -> dict:
    """chat id -> rows, for the chats a sidebar shows. Only chats with something to list."""
    out = {}
    for sid in ids[:MAX_IDS]:
        s = store.get_session(sid)
        if not s or s["chat_id"] != chat_id or s.get("parent_session"):
            continue
        rows = tree(s)
        if rows:
            out[sid] = rows
    return out
