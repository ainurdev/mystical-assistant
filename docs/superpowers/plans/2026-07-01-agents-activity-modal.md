# Agents Activity Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a pill at the end of a session's chat — "⚡ N agents working" / "N agents ran" — that opens a modal listing each subagent (what it's doing, type, running/done) with a live per-agent activity feed.

**Architecture:** A read-only backend module (`bridge/agents.py`) derives everything from the files Claude Code already writes to `~/.claude/projects/<enc>/<sid>/subagents/agent-<id>.{jsonl,meta.json}`: the roster from `*.meta.json`, live activity by tailing each `agent-<id>.jsonl`, and running/done status by correlating each agent's `toolUseId` against `tool_result`s in the main transcript. New GET endpoints on both HTTP servers expose it; parallel `AgentsPill` + `AgentsModal` components render it in the Mini App and dashboard. No changes to `runner.py`'s streaming path.

**Tech Stack:** Python 3 stdlib (`os`, `json`, `glob`, `re`); React 19 + Vite (both web trees), Tailwind + Mystic tokens.

## Global Constraints

- **Read-only.** `bridge/agents.py` never writes and never touches a live run; all file reads swallow `OSError`/`JSONDecodeError` per line.
- **Env:** use `python3` (this environment has no `python`).
- **Path safety:** `agent_id` must match `^agent-[A-Za-z0-9_]+$` and resolve strictly inside the session's `subagents/` dir — reject traversal.
- **Data source is fixed:** subagents live at `<dirname(find_transcript(sid))>/<sid>/subagents/`; status "done" iff the agent's `toolUseId` appears as a `tool_result` `tool_use_id` in the main transcript, else "running".
- **Owner scoping:** every endpoint resolves the session via `store.get_session` and 404s unless it belongs to the caller (`chat_id` on Mini App, `chat` on dashboard).
- **Frontends are parallel, not shared:** build `AgentsPill`/`AgentsModal` in each web tree (like `PermissionCard` already is). No shared package.
- **Frontend gate:** `pnpm -C <web> exec tsc -b` + `pnpm -C <web> build` (fall back to `pnpm -C <web> exec vite build` if esbuild trips — per project memory). No frontend unit harness. Don't restart the bridge mid-session.
- **Backend tests:** `python3 tests/test_agents.py` (stdlib `unittest`-style plain asserts + `__main__` runner), reusing the header idiom from `tests/test_bridge.py`.

---

## File Structure

**Create:**
- `bridge/agents.py` — read-only subagent roster + activity.
- `tests/test_agents.py` — backend tests over a fabricated `subagents/` fixture.
- `bridge/miniapp/web/src/components/AgentsPill.tsx`
- `bridge/miniapp/web/src/components/AgentsModal.tsx`
- `bridge/dashboard/web/src/components/AgentsPill.tsx`
- `bridge/dashboard/web/src/components/AgentsModal.tsx`

**Modify:**
- `bridge/miniapp/server.py` — 2 GET routes + handlers (+ import `agents`).
- `bridge/dashboard/server.py` — 2 GET routes in `_get_api` (+ import `agents`).
- `bridge/miniapp/web/src/lib/api.ts` — `AgentInfo`/`AgentsInfo`/`AgentActivity` types + 2 methods.
- `bridge/miniapp/web/src/routes/run.tsx` — render `<AgentsPill>`.
- `bridge/dashboard/web/src/api.ts` — same types + 2 methods.
- `bridge/dashboard/web/src/App.tsx` — render `<AgentsPill>` after the transcript.
- `README.md` — one Features bullet.

---

## Task 1: `bridge/agents.py` + tests

**Files:**
- Create: `bridge/agents.py`
- Test: `tests/test_agents.py`

**Interfaces:**
- Consumes: `transcript_jsonl.find_transcript(sid) -> str|None`, `transcript_jsonl.PROJECTS_DIR`, `transcript_jsonl._summarize_tool(name, inp) -> str`; `store.get_session` (only in endpoints, not here).
- Produces:
  - `session_agents(session: dict) -> {"running": int, "total": int, "agents": list[dict]}` where each agent = `{agent_id, agent_type, description, tool_use_id, spawn_depth, status, started_at, updated_at}`.
  - `agent_activity(session: dict, agent_id: str, cursor: int=0) -> {"events": list, "next_cursor": int, "status": str, "description": str, "agent_type": str}` where events are `{"type":"text","text":str}` or `{"type":"tool","name":str,"summary":str}`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_agents.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 tests/test_agents.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'bridge.agents'`

- [ ] **Step 3: Write `bridge/agents.py`**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 tests/test_agents.py`
Expected: `all passed`

- [ ] **Step 5: Commit**

```bash
git add bridge/agents.py tests/test_agents.py
git commit -m "feat(agents): read-only subagent roster + activity module"
```

---

## Task 2: Mini App endpoints

**Files:**
- Modify: `bridge/miniapp/server.py` (import `agents`; `do_GET` dispatch; 2 handler methods)

**Interfaces:**
- Consumes: `agents.session_agents(session)`, `agents.agent_activity(session, agent_id, cursor)`, `store.get_session`.
- Produces (HTTP): `GET /api/agents?session=<id>` → roster; `GET /api/agents/activity?session=<id>&agent=<agent_id>&cursor=<n>` → activity.

- [ ] **Step 1: Import `agents`**

In `bridge/miniapp/server.py`, add `agents` to the existing `from bridge import ...` line (which already imports `store, runner, ...`).

- [ ] **Step 2: Add GET routes**

In `do_GET`, alongside the other `if path == "/api/...":` branches (e.g. after `/api/running`), add:

```python
            if path == "/api/agents":
                return self._api_agents(chat_id, qs)
            if path == "/api/agents/activity":
                return self._api_agent_activity(chat_id, qs)
```

- [ ] **Step 3: Add handler methods**

Add to the request-handler class (near `_api_history`):

```python
    def _agents_session(self, chat_id: int, qs):
        sid = qs.get("session", [""])[0]
        s = store.get_session(sid) if sid else None
        if not s or s["chat_id"] != chat_id:
            return None
        return s

    def _api_agents(self, chat_id: int, qs):
        s = self._agents_session(chat_id, qs)
        if not s:
            return self._json({"error": "not found"}, 404)
        self._json(agents.session_agents(s))

    def _api_agent_activity(self, chat_id: int, qs):
        s = self._agents_session(chat_id, qs)
        if not s:
            return self._json({"error": "not found"}, 404)
        try:
            cursor = int(qs.get("cursor", ["0"])[0])
        except ValueError:
            cursor = 0
        self._json(agents.agent_activity(s, qs.get("agent", [""])[0], cursor))
```

- [ ] **Step 4: Verify**

Run:
```bash
python3 -c "import ast; ast.parse(open('bridge/miniapp/server.py').read()); import bridge.miniapp.server; print('ok')"
python3 -m pytest tests/test_bridge.py -q
```
Expected: `ok`; test_bridge shows its **pre-existing** failures only (`test_valid_init_data`, `test_dashboard_security_helpers`, `test_dashboard_ws_authorization` — env-dependent, unrelated); no NEW failures.

- [ ] **Step 5: Commit**

```bash
git add bridge/miniapp/server.py
git commit -m "feat(miniapp): agents roster + activity API routes"
```

---

## Task 3: Dashboard endpoints

**Files:**
- Modify: `bridge/dashboard/server.py` (import `agents`; `_get_api` dispatch)

**Interfaces:**
- Produces (HTTP): `GET /local/agents?session=<id>`; `GET /local/agents/activity?session=<id>&agent=<agent_id>&cursor=<n>`. `chat` is in scope in `_get_api`.

- [ ] **Step 1: Import `agents`**

In `bridge/dashboard/server.py`, add `agents` to the existing multi-line `from bridge import (...)` tuple (keep it consistent with neighbors).

- [ ] **Step 2: Add GET routes in `_get_api`**

Alongside the other `/local/...` branches:

```python
        if path == "/local/agents":
            sid = qs.get("session", [""])[0]
            s = store.get_session(sid) if sid else None
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            return self._json(agents.session_agents(s))
        if path == "/local/agents/activity":
            sid = qs.get("session", [""])[0]
            s = store.get_session(sid) if sid else None
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            return self._json(agents.agent_activity(s, qs.get("agent", [""])[0], cursor))
```

- [ ] **Step 3: Verify**

Run:
```bash
python3 -c "import ast; ast.parse(open('bridge/dashboard/server.py').read()); import bridge.dashboard.server; print('ok')"
python3 -m pytest tests/test_bridge.py -q
```
Expected: `ok`; only the 3 pre-existing failures, no new ones.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/server.py
git commit -m "feat(dashboard): agents roster + activity API routes"
```

---

## Task 4: Mini App — api + AgentsPill + AgentsModal + wire

**Files:**
- Modify: `bridge/miniapp/web/src/lib/api.ts`
- Create: `bridge/miniapp/web/src/components/AgentsModal.tsx`, `bridge/miniapp/web/src/components/AgentsPill.tsx`
- Modify: `bridge/miniapp/web/src/routes/run.tsx`

**Interfaces:**
- Produces: `api.agents(sessionId)`, `api.agentActivity(sessionId, agentId, cursor)`; types `AgentInfo`, `AgentsInfo`, `AgentActivity`; `<AgentsPill sessionId running/>`.

- [ ] **Step 1: Add types + api methods**

In `bridge/miniapp/web/src/lib/api.ts`, add near the other exported types:

```ts
export type AgentInfo = {
  agent_id: string;
  agent_type: string;
  description: string;
  tool_use_id: string;
  spawn_depth: number;
  status: "running" | "done";
  started_at: number;
  updated_at: number;
};
export type AgentsInfo = { running: number; total: number; agents: AgentInfo[] };
export type AgentActivityEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string };
export type AgentActivity = {
  events: AgentActivityEvent[];
  next_cursor: number;
  status: "running" | "done";
  description: string;
  agent_type: string;
};
```

And into the `export const api = {...}` object:

```ts
  agents: (sessionId: string) =>
    request<AgentsInfo>(`/api/agents?session=${encodeURIComponent(sessionId)}`),
  agentActivity: (sessionId: string, agentId: string, cursor: number) =>
    request<AgentActivity>(
      `/api/agents/activity?session=${encodeURIComponent(sessionId)}` +
        `&agent=${encodeURIComponent(agentId)}&cursor=${cursor}`,
    ),
```

- [ ] **Step 2: Create AgentsModal**

`bridge/miniapp/web/src/components/AgentsModal.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, type AgentInfo } from "../lib/api";
import { Markdown } from "./Markdown";

export function AgentsModal({
  sessionId,
  agents,
  onClose,
}: {
  sessionId: string;
  agents: AgentInfo[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(agents[0]?.agent_id ?? null);
  const cursorRef = useRef(0);
  const [events, setEvents] = useState<AgentActivityRow[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cursorRef.current = 0;
    setEvents([]);
  }, [selected]);

  const { data } = useQuery({
    queryKey: ["agent-activity", sessionId, selected, "poll"],
    enabled: selected !== null,
    queryFn: async () => {
      const a = await api.agentActivity(sessionId, selected as string, cursorRef.current);
      if (a.events.length) {
        setEvents((prev) => [...prev, ...a.events]);
        cursorRef.current = a.next_cursor;
      }
      return a;
    },
    refetchInterval: (q) =>
      (q.state.data?.status ?? "running") === "running" ? 1000 : false,
  });

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--tg-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--tg-button)]/20 p-3">
        <span className="text-sm font-semibold">Agents</span>
        <span className="flex-1" />
        <button onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-2/5 overflow-y-auto border-r border-[var(--tg-button)]/20">
          {agents.map((a) => (
            <button
              key={a.agent_id}
              onClick={() => setSelected(a.agent_id)}
              className={`block w-full px-3 py-2 text-left text-xs ${
                a.agent_id === selected ? "bg-[var(--tg-secondary-bg)]" : ""
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    a.status === "running" ? "bg-green-400" : "bg-[var(--tg-hint)]"
                  }`}
                />
                <span className="truncate">{a.description || a.agent_id}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-[var(--tg-hint)]">
                {a.agent_type}
                {a.spawn_depth > 1 ? ` · depth ${a.spawn_depth}` : ""}
              </div>
            </button>
          ))}
        </div>
        <div ref={feedRef} className="min-w-0 flex-1 space-y-2 overflow-y-auto p-3">
          {events.length === 0 && (
            <div className="text-xs text-[var(--tg-hint)]">No activity yet.</div>
          )}
          {events.map((e, i) =>
            e.type === "text" ? (
              <Markdown key={i} className="text-sm leading-relaxed">
                {e.text}
              </Markdown>
            ) : (
              <div
                key={i}
                className="flex items-center gap-1.5 font-mono text-xs text-[var(--tg-hint)]"
              >
                <span className="font-semibold">{e.name}</span>
                <span className="min-w-0 break-all">{e.summary}</span>
              </div>
            ),
          )}
          {data?.status === "running" && (
            <div className="text-xs text-[var(--tg-hint)]">Working…</div>
          )}
        </div>
      </div>
    </div>
  );
}

type AgentActivityRow =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string };
```

- [ ] **Step 3: Create AgentsPill**

`bridge/miniapp/web/src/components/AgentsPill.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { api } from "../lib/api";
import { AgentsModal } from "./AgentsModal";

export function AgentsPill({
  sessionId,
  running,
}: {
  sessionId: string | null;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["agents", sessionId],
    enabled: sessionId !== null,
    queryFn: () => api.agents(sessionId as string),
    refetchInterval: running ? 1500 : false,
  });
  if (!sessionId || !data || data.total === 0) return null;
  const label =
    data.running > 0 ? `${data.running} agents working` : `${data.total} agents ran`;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 self-start rounded-full bg-[var(--tg-secondary-bg)] px-3 py-1 text-xs font-medium text-[var(--brand-soft)]"
      >
        <Zap size={13} aria-hidden />
        {label}
      </button>
      {open && (
        <AgentsModal
          sessionId={sessionId}
          agents={data.agents}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Wire into run.tsx**

In `bridge/miniapp/web/src/routes/run.tsx`:
- Add the import: `import { AgentsPill } from "../components/AgentsPill";`
- Line 11 currently: `const { turns, activeTurn, sessionWorking, respond, sendError } = useChat();` — add `sessionId` and `isRunning`: `const { turns, activeTurn, sessionWorking, respond, sendError, sessionId, isRunning } = useChat();`
- Just before the final `<div ref={bottomRef} />`, render the pill:
```tsx
      <AgentsPill sessionId={sessionId} running={isRunning} />
```

- [ ] **Step 5: Verify types + build**

Run:
```bash
pnpm -C bridge/miniapp/web exec tsc -b && pnpm -C bridge/miniapp/web build
```
Expected: succeed (fallback `pnpm -C bridge/miniapp/web exec vite build`).

- [ ] **Step 6: Commit**

```bash
git add bridge/miniapp/web/src
git commit -m "feat(miniapp): agents-working pill + activity modal"
```

---

## Task 5: Dashboard — api + AgentsPill + AgentsModal + wire

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`
- Create: `bridge/dashboard/web/src/components/AgentsModal.tsx`, `bridge/dashboard/web/src/components/AgentsPill.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx`

**Interfaces:**
- Produces: `api.agents(sessionId)`, `api.agentActivity(sessionId, agentId, cursor)`; types `AgentInfo`/`AgentsInfo`/`AgentActivity`; `<AgentsPill sessionId running/>`.

- [ ] **Step 1: Add types + api methods**

In `bridge/dashboard/web/src/api.ts`, add near the other exported types:

```ts
export type AgentInfo = {
  agent_id: string;
  agent_type: string;
  description: string;
  tool_use_id: string;
  spawn_depth: number;
  status: "running" | "done";
  started_at: number;
  updated_at: number;
};
export type AgentsInfo = { running: number; total: number; agents: AgentInfo[] };
export type AgentActivityEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string };
export type AgentActivity = {
  events: AgentActivityEvent[];
  next_cursor: number;
  status: "running" | "done";
  description: string;
  agent_type: string;
};
```

And into the `export const api = {...}` object (GETs need no token; `req` adds it only for bodies):

```ts
  agents: (sessionId: string) =>
    req<AgentsInfo>(`/local/agents?session=${encodeURIComponent(sessionId)}`),
  agentActivity: (sessionId: string, agentId: string, cursor: number) =>
    req<AgentActivity>(
      `/local/agents/activity?session=${encodeURIComponent(sessionId)}` +
        `&agent=${encodeURIComponent(agentId)}&cursor=${cursor}`,
    ),
```

- [ ] **Step 2: Create AgentsModal**

`bridge/dashboard/web/src/components/AgentsModal.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AgentInfo } from "../api";
import { Markdown } from "./Markdown";

type Row = { type: "text"; text: string } | { type: "tool"; name: string; summary: string };

export function AgentsModal({
  sessionId,
  agents,
  onClose,
}: {
  sessionId: string;
  agents: AgentInfo[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(agents[0]?.agent_id ?? null);
  const cursorRef = useRef(0);
  const [events, setEvents] = useState<Row[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cursorRef.current = 0;
    setEvents([]);
  }, [selected]);

  const { data } = useQuery({
    queryKey: ["agent-activity", sessionId, selected],
    enabled: selected !== null,
    queryFn: async () => {
      const a = await api.agentActivity(sessionId, selected as string, cursorRef.current);
      if (a.events.length) {
        setEvents((prev) => [...prev, ...a.events]);
        cursorRef.current = a.next_cursor;
      }
      return a;
    },
    refetchInterval: (q) =>
      (q.state.data?.status ?? "running") === "running" ? 1000 : false,
  });

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,.55)",
               display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: "min(900px,92vw)", height: "min(600px,88vh)", display: "flex",
                 flexDirection: "column", border: "1px solid var(--border-bright)",
                 background: "var(--panel)" }}
      >
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px",
                      borderBottom: "1px solid rgba(127,233,216,.14)" }}>
          <span style={{ fontSize: 11, letterSpacing: 1.5, color: "#9fc7c0" }}>AGENTS</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ appearance: "none", cursor: "pointer",
                  border: "1px solid rgba(127,233,216,.25)", background: "transparent",
                  color: "#9fc7c0", fontFamily: "inherit", fontSize: 11, padding: "2px 8px" }}>
            ✕
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", flex: 1, minHeight: 0 }}>
          <div className="mscroll" style={{ borderRight: "1px solid rgba(127,233,216,.14)",
                       overflowY: "auto", minHeight: 0 }}>
            {agents.map((a) => {
              const on = a.agent_id === selected;
              return (
                <div key={a.agent_id} onClick={() => setSelected(a.agent_id)}
                     style={{ padding: "9px 11px", cursor: "pointer",
                              borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`,
                              background: on ? "rgba(127,233,216,.08)" : "transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%",
                                   background: a.status === "running" ? "#8fd9a8" : "#3c544f" }} />
                    <span style={{ fontSize: 12, color: "#cfe9e3", overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.description || a.agent_id}
                    </span>
                  </div>
                  <div style={{ fontSize: 9.5, color: "#3c544f", marginTop: 4 }}>
                    {a.agent_type}{a.spawn_depth > 1 ? ` · depth ${a.spawn_depth}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
          <div ref={feedRef} className="mscroll" style={{ overflowY: "auto", minHeight: 0,
                       padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {events.length === 0 && (
              <div style={{ fontSize: 11, color: "#3c544f" }}>No activity yet.</div>
            )}
            {events.map((e, i) =>
              e.type === "text" ? (
                <div key={i} style={{ fontSize: 12, color: "#bfe6de", lineHeight: 1.6 }}>
                  <Markdown>{e.text}</Markdown>
                </div>
              ) : (
                <div key={i} style={{ display: "flex", gap: 8, fontFamily: "'JetBrains Mono',monospace",
                             fontSize: 11, color: "#6f938d" }}>
                  <span style={{ color: "#9fc7c0" }}>{e.name}</span>
                  <span style={{ minWidth: 0, wordBreak: "break-all" }}>{e.summary}</span>
                </div>
              ),
            )}
            {data?.status === "running" && (
              <div style={{ fontSize: 11, color: "#6f938d" }}>Working…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create AgentsPill**

`bridge/dashboard/web/src/components/AgentsPill.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { AgentsModal } from "./AgentsModal";

export function AgentsPill({
  sessionId,
  running,
}: {
  sessionId: string | null;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["agents", sessionId],
    enabled: sessionId !== null,
    queryFn: () => api.agents(sessionId as string),
    refetchInterval: running ? 1500 : false,
  });
  if (!sessionId || !data || data.total === 0) return null;
  const label =
    data.running > 0 ? `⚡ ${data.running} agents working` : `${data.total} agents ran`;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{ appearance: "none", cursor: "pointer", alignSelf: "flex-start",
                 border: "1px solid rgba(127,233,216,.35)", background: "rgba(127,233,216,.06)",
                 color: "#7fe9d8", fontFamily: "inherit", fontSize: 11, letterSpacing: 0.5,
                 padding: "4px 11px", borderRadius: 999 }}
      >
        {label}
      </button>
      {open && (
        <AgentsModal
          sessionId={sessionId}
          agents={data.agents}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Wire into App.tsx**

In `bridge/dashboard/web/src/App.tsx`:
- Add: `import { AgentsPill } from "./components/AgentsPill";`
- Find where the transcript is rendered (grep `Transcript` / where `turns` are shown in the chat column). Immediately after that transcript element, render:
```tsx
        <AgentsPill sessionId={sessionId} running={isWorking} />
```
`sessionId` (state) and `isWorking` (the `=== "working"` derivation, ~line 114) are already in scope in `App.tsx`.

- [ ] **Step 5: Verify types + build**

Run:
```bash
pnpm -C bridge/dashboard/web exec tsc -b && pnpm -C bridge/dashboard/web build
```
Expected: succeed (fallback `pnpm -C bridge/dashboard/web exec vite build`).

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "feat(dashboard): agents-working pill + activity modal"
```

---

## Task 6: README + manual smoke

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Features bullet**

In `README.md`, in the `## Features` list, add:

```markdown
- **Live agent activity.** When a run spawns subagents (the `Task` tool), a
  pill at the end of the chat shows "⚡ N agents working"; open it for a modal
  listing each subagent (what it's doing, its type, running/done) with a live
  per-agent activity feed. Read-only, derived from Claude Code's on-disk
  subagent transcripts — works on the Mini App and dashboard.
```

- [ ] **Step 2: Full backend suite**

Run: `python3 tests/test_agents.py && python3 -m pytest tests/test_bridge.py -q`
Expected: `all passed`; test_bridge shows only its 3 pre-existing env failures.

- [ ] **Step 3: Manual smoke (bridge running)**

Send a prompt to a session that will spawn subagents (e.g. "use 2 parallel agents to summarize files A and B"). While it runs, a "⚡ N agents working" pill appears at the end of the chat on both the Mini App and dashboard. Open it: the roster lists each subagent with its description/type and a green running dot; selecting one streams its live text + tool calls; dots flip to done and the label becomes "N agents ran" when finished.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: live agent activity feature"
```

---

## Self-Review notes (author)

- **Spec coverage:** `agents.py` roster+activity+status (T1) ✓; correlation via `toolUseId`↔`tool_result` (T1 `_completed_tool_use_ids`) ✓; endpoints both servers (T2/T3) ✓; pill + modal both surfaces (T4/T5) ✓; per-session scope, persist-after-done, flat+depth nesting (pill/modal logic) ✓; read-only + traversal guard + malformed-line skips (T1) ✓; tests (T1) ✓.
- **Placeholder scan:** none — every code step carries full code; the one grep-locate (dashboard transcript render site, T5 S4) names the exact prop values and in-scope variables.
- **Type consistency:** `AgentInfo`/`AgentsInfo`/`AgentActivity` identical across both `api.ts` files, backend keys (`agent_id`, `agent_type`, `spawn_depth`, `status`, `next_cursor`) match the TS types and the `session_agents`/`agent_activity` returns.
