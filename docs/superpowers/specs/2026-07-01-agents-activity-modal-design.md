# Agents activity modal

When a session's Claude run spawns subagents (the `Task` tool) or workflows, show
a pill at the end of that session's chat — **"⚡ N agents working"** while any run,
**"N agents ran"** afterward — that opens a modal listing each subagent (what it's
doing, its type, running/done) with a **live activity feed** per agent. This gives
the same visibility you get watching Claude Code spawn agents, inside the bridge's
own chat surfaces.

This is a **read-only** feature: it derives everything from files Claude Code
already writes to disk. It does not touch `runner.py`'s streaming path.

## What already exists (verified)

- **Subagent transcripts on disk.** Claude Code writes each subagent's full
  activity to `~/.claude/projects/<enc-cwd>/<session-uuid>/subagents/agent-<id>.jsonl`,
  beside the flat main transcript `<enc-cwd>/<session-uuid>.jsonl`. Confirmed on
  this machine (e.g. this very session's dir holds 34 `agent-*.jsonl`). Each has a
  companion **`agent-<id>.meta.json`**:
  ```json
  {"agentType":"general-purpose","description":"Review Task 2 (spec + quality)",
   "toolUseId":"toolu_01Foed…","spawnDepth":1}
  ```
  `description` = the "on what"; `agentType` = the kind; `spawnDepth` = nesting
  (1 = spawned by the main agent); **`toolUseId` = the parent `Task` tool_use id**,
  so each subagent correlates to its `Task` line in the main transcript.
- **Subagent JSONL records** carry `type` (`user`/`assistant`), `isSidechain:true`,
  `agentId`, `uuid`, `parentUuid`, `timestamp`, and a `message` whose `content` is
  text and `tool_use`/`tool_result` blocks — the same shape `transcript_jsonl.py`
  already parses for main transcripts.
- **`bridge/transcript_jsonl.py`** exposes `PROJECTS_DIR` (the `~/.claude/projects`
  root) and helpers like `recover_cwd(path)`, `first_user_text(path)`, and the
  block-walking used to turn records into compact events. `native.py` scans
  `PROJECTS_DIR/<enc-cwd>/<uuid>.jsonl` and links store rows by `claude_session_id`.
- **Store sessions** carry `claude_session_id` (the on-disk uuid) and `cwd`
  (`store.get_session` → dict). `runner`'s streaming turns persist
  `claude_session_id` as soon as the init event arrives.
- **Servers**: `bridge/miniapp/server.py` (`do_GET` dispatch on `/api/*`, auth via
  `validate_init_data`/`_auth`, `_json`) and `bridge/dashboard/server.py`
  (`_get_api` on `/local/*`, Host + `_tok_ok` gates, `_json`). New GET endpoints
  slot into each.
- **Frontends are parallel, not shared** (`bridge/miniapp/web`, `bridge/dashboard/web`
  — two Vite apps that duplicate components, e.g. `PermissionCard`). The pill +
  modal are built in each tree. Both serve a prebuilt `web/dist` (rebuild via local
  bins; `pnpm build` can trip on esbuild → fall back to `vite build`; don't restart
  the bridge mid-session — per project memory). Frontend gate is `tsc -b` + build
  (no unit harness). Backend tests: `tests/test_*.py` (stdlib `unittest`).

## 1. Backend — `bridge/agents.py` (new, read-only)

Stdlib only (`os`, `json`, `glob`, `time`). No writes, ever.

- `_subagents_dir(session) -> str | None` — from `session["claude_session_id"]`,
  glob `PROJECTS_DIR/*/<sid>/subagents`; return it if it exists, else `None`.
  (Globbing the uuid avoids re-deriving the cwd→dir encoding.)
- `_completed_tool_use_ids(session) -> set[str]` — read the main transcript
  `PROJECTS_DIR/*/<sid>.jsonl` and collect every `tool_result` block's
  `tool_use_id`. Used for deterministic done-status. Bad/partial lines skipped.
- `session_agents(session) -> dict` — returns
  `{"running": int, "total": int, "agents": [Agent]}` where each `Agent` is
  `{agent_id, agent_type, description, tool_use_id, spawn_depth, status,
    started_at, updated_at}`. Built from each `*.meta.json` in the subagents dir;
  `status` is `"done"` if the turn is no longer running **or** `tool_use_id` is in
  `_completed_tool_use_ids`, else `"running"`; `started_at`/`updated_at` from the
  agent jsonl's file ctime/mtime. Sorted by `started_at`. `running` counts
  `status == "running"`.
- `agent_activity(session, agent_id, cursor=0) -> dict` — validate `agent_id`
  matches `^agent-[A-Za-z0-9]+$` and resolve strictly within the subagents dir
  (reject traversal). Read `agent-<id>.jsonl` from record index `cursor`, walk
  message content into a compact feed: `{type:"text", text}` and
  `{type:"tool", name, summary}` (reusing the `_summarize_tool`-style truncation).
  Return `{events, next_cursor, status, description, agent_type}`. Never raises on
  a malformed file — returns what parsed.

If a session has no `claude_session_id` or no subagents dir, `session_agents`
returns `{"running":0,"total":0,"agents":[]}` (the pill then hides).

## 2. API (both servers)

- Mini App (`bridge/miniapp/server.py`, GET, `_auth`-gated, owner-scoped —
  resolve the session via `store.get_session` and 404 unless `chat_id == session
  chat_id`):
  - `GET /api/agents?session=<id>` → `session_agents(...)`
  - `GET /api/agents/activity?session=<id>&agent=<agent_id>&cursor=<n>` → `agent_activity(...)`
- Dashboard (`bridge/dashboard/server.py`, `_get_api`, `chat`-scoped): mirror as
  `GET /local/agents` and `GET /local/agents/activity`.

## 3. Frontend — pill + modal (both trees, parallel components)

- **api**: add `agents(sessionId)` and `agentActivity(sessionId, agentId, cursor)`
  to each app's api wrapper (Mini App `request<T>`, dashboard `req<T>`), plus a
  shared-shape `AgentInfo` type.
- **AgentsPill** (rendered at the end of the transcript): polls `agents(sessionId)`
  every ~1.5s while the session's turn is running, and once on mount otherwise.
  Hidden when `total === 0`. Label: `⚡ {running} agents working` when
  `running > 0`, else `{total} agents ran`. Click → opens the modal.
- **AgentsModal**: left pane = agent roster (description, an `agentType` chip, a
  `spawnDepth>1` depth badge, a running/done dot); right pane = the selected
  agent's feed via `agentActivity(...)`, polled (~1s) with the cursor and
  auto-scrolled while `status === "running"`. Reuses each app's `Markdown` for text
  and the existing tool-line style for tool events. Mini App: a full-screen sheet;
  dashboard: a floating panel/modal consistent with `AnalyzeModal`.

Scope is **per-session** (the chat you're viewing). The pill **persists after
completion** for review. Nested agents (`spawnDepth>1`) are shown flat with a depth
badge (tree view deferred).

## 4. Error handling

- Missing session dir / no subagents / unreadable file → empty roster, pill hidden;
  never an error to the user.
- Malformed JSONL lines skipped individually (as `transcript_jsonl` does).
- `agent_id` is regex-validated and path-confined — no directory traversal.
- Strictly read-only; a slow/huge subagent file is bounded by the `cursor` window.

## 5. Testing

Backend (`tests/test_agents.py`, stdlib `unittest`, temp `PROJECTS_DIR` via
monkeypatching `transcript_jsonl.PROJECTS_DIR` + a fabricated
`<enc>/<sid>/subagents/` fixture with two `meta.json`+`jsonl` pairs and a main
`<sid>.jsonl` carrying one matching `tool_result`):
- `_subagents_dir` finds the dir by uuid; returns `None` when absent.
- `session_agents` roster fields map from meta.json; `running`/`done` status
  (one agent whose `toolUseId` has a `tool_result` → done; the other → running);
  `total`/`running` counts.
- `agent_activity` parses text + tool events, honors `cursor`/`next_cursor`, and
  rejects a traversal `agent_id`.

Frontend gate: `tsc -b` + build for each app; visual check of the pill + modal.

## Build sequence

1. `bridge/agents.py` + `tests/test_agents.py` (red→green).
2. Mini App endpoints; then dashboard endpoints.
3. Mini App api + `AgentInfo` type; `AgentsPill`; `AgentsModal`; wire pill into the
   transcript view.
4. Dashboard api; `AgentsPill`; `AgentsModal`; wire into the transcript view.
5. README feature bullet.
