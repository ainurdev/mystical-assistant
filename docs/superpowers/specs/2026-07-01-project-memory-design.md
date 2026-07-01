# Project memory

Give every turn a small, **curated, project + branch-scoped** memory so a session
instantly knows *its* project — conventions, past decisions, your preferences, the
active goal — and therefore decides faster and better, while **spending fewer
tokens** (it stops re-exploring and re-litigating what's already known). The bridge
already sits in the middle of every turn (`sessions → turns → events`), and every
`claude` invocation flows through one seam — `--append-system-prompt` in
`runner.py` — so that seam is where a compact memory block is injected. Nothing else
about how Claude Code is driven changes.

This is **semantic (declarative) memory** — durable facts and decisions — not an
episodic log of what the agent did. It is built lean on the existing SQLite store,
not adopted from an external framework or plugin (see "Alternatives weighed").

## Decisions locked (during brainstorming)

- **Build-lean on the bridge's own SQLite store** (own the data, surface it in the
  Mini App / dashboard, work offline, per-owner). Not Mem0/Zep/Letta (their own
  runtimes/services) and not `claude-mem` (episodic, separate store, headless-CLI
  integration risk). We *borrow* Mem0's reconcile pattern and `claude-mem`'s
  progressive-disclosure retrieval.
- **Hybrid capture** — a cheap Haiku pass proposes facts after a turn; you **Keep /
  Skip** each. Nothing enters memory blindly.
- **All four content types** — conventions/facts/gotchas, decisions/rationale
  (project scope); preferences/style (**user-global** scope); goals/task-state
  (volatile, project/branch scope).
- **Retrieval Approach C** — flat, tiered, cache-aligned injection now; the schema +
  a single `retrieve()` seam are ready to flip on `sqlite-vec` semantic search later
  with no migration.

### Excluded (deliberately, for the MVP)

Episodic/activity memory (`claude-mem` style); a knowledge-graph or temporal-graph
store (Zep/Graphiti — overkill at this scale); adopting an agent-memory runtime
(Letta); auto-capture without the Keep/Skip gate; semantic re-ranking inside the
always-injected block (see §4 — it would break prompt caching).

## What already exists (verified)

- **Store** (`bridge/store.py`) is the single SQLite source of truth
  (`sessions → turns → events`). `_connect()` is WAL + autocommit + `Row` factory;
  `init()` runs an idempotent `executescript(_SCHEMA)` plus in-line
  `ALTER TABLE … ADD COLUMN` migrations guarded by `PRAGMA table_info`. New tables
  follow that same idempotent pattern.
- **Events** are typed rows `(session_id, turn_id, seq, type, payload, ts)`. Card
  types (`permission`, `question`) are just events the frontends render on poll. A
  new `memory_candidate` event reuses this mechanism exactly.
- **Runner** (`bridge/runner.py`): `_base_cmd(...)` builds the `claude` argv and is
  the **only** injection seam — it already appends `config.ASK_SYSTEM_PROMPT` + a
  dev-log note via `--append-system-prompt` (~L106). `run_blocking(chat_id, prompt,
  resume_id=None, …)` is a one-shot `claude -p`; it currently passes **no** `model`,
  though `_base_cmd` already accepts one (`--model`). Turn completion fans out
  through `notify_turn_done(...)` — the capture hook attaches right after a turn
  finalizes.
- **Per-project settings** (`bridge/project_config.py`) are keyed
  `f"{project}@{branch}"` with a directory-only fallback — memory reuses this exact
  `project@branch` keying for its namespace.
- **HTTP servers** (`miniapp/server.py`, `dashboard/server.py`) are stdlib
  `do_GET`/`do_POST` dispatchers on `/api/*`, each with its own auth
  (`validate_init_data` for the Mini App, `?token=` for the dashboard). New
  endpoints are added to both, behind each server's auth.
- **Frontends are parallel, not shared.** `bridge/miniapp/web` and
  `bridge/dashboard/web` are two React 19 + Vite apps that duplicate components
  (`PermissionCard.tsx`, `QuestionCard.tsx` exist in both). "Shared component" means
  build the same Mystic-themed component in each tree. Both serve a prebuilt
  `web/dist` (rebuild via local bins; `pnpm build` can trip on esbuild; don't restart
  the bridge mid-session — per project memory).
- **Tests** live in `tests/test_*.py` (stdlib `unittest`), backend only; the
  frontends' gate is `tsc -b` + `vite build` + a visual check.

## 1. Data model — `memories` table (`store.py`)

Idempotent `CREATE TABLE IF NOT EXISTS`, following the store's pattern:

```
memories(
  id            TEXT PRIMARY KEY,   -- uuid4
  owner_id      INTEGER NOT NULL,   -- chat_id
  scope         TEXT NOT NULL,      -- 'user' | 'project'
  project_path  TEXT,               -- NULL when scope='user'
  branch        TEXT,               -- NULL = project-wide (or user scope); else branch-specific
  type          TEXT NOT NULL,      -- convention | decision | preference | goal | gotcha
  title         TEXT NOT NULL,      -- short label
  body          TEXT NOT NULL,      -- the fact, terse (one or two lines)
  status        TEXT NOT NULL,      -- candidate | active | archived
  pinned        INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT,           -- provenance
  source_turn_id    TEXT,
  supersedes_id     TEXT,           -- set on an UPDATE candidate: the memory it replaces on Keep
  embedding     BLOB,               -- RESERVED for Approach B; NULL until sqlite-vec is on
  use_count     INTEGER NOT NULL DEFAULT 0,
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL,
  last_used_at  REAL
)
```

Index `(owner_id, scope, project_path, branch, status)` so the resident read (§4) is
a single fast lookup. Helpers mirror existing naming: `add_memory`, `get_memory`,
`list_memories(owner, scope=…, project=…, branch=…, status=…, type=…)`,
`set_memory_status`, `set_pinned`, `update_memory`, `touch_memory` (`use_count++`,
stamp `last_used_at`), and `supersede_memory(old_id, **new)` (archive `old_id`, add
the replacement in one call).

**Namespace + cascade.** The scope key is the tuple `(owner, scope, project,
branch)` — the standard agent-memory namespacing pattern, reusing `project_config`'s
`project@branch`. `resolve_memories(owner, project, branch)` returns the **cascade**:

- `user` scope, `status='active'` (your preferences — travel everywhere), **plus**
- `project` scope for `project`, `branch IS NULL` (repo-wide facts), **plus**
- `project` scope for `project`, `branch = branch` (this branch's goals).

## 2. The shared spine (Phase 0)

Two primitives, built once; both memory and the already-spec'd teacher-mode ride
them (teacher-mode plugs in later as a second proposer — §8, out of scope here).

- **Context Pack** — `render_pack(owner, project, branch) -> str` (in `bridge/memory.py`),
  called from `_base_cmd` and appended to the existing `--append-system-prompt`
  content. It is **memoized by `(owner, project, branch, memory_version)`** — where
  `memory_version = max(updated_at)` over that namespace — so the string is
  **byte-identical across every turn of a session** until memory actually changes — this is load-bearing for token cost (§4). `_base_cmd` gains a
  `skip_pack: bool` so capture/teach invocations (§3) don't get the pack (avoids
  bias, recursion, and cost).
- **Post-turn Extractor** — a fire-and-forget hook dispatched where
  `notify_turn_done` fires. A tiny dispatch that runs *proposers*; today one
  (memory). It **never delays or blocks** the turn or the "done" notification.

## 3. Capture pipeline — two gates (`bridge/memory.py`)

`propose(session, turn, assistant_text, edited_files)`:

1. Guard: return unless `config.MEMORY_ENABLE` **and** the turn produced output.
2. Gather the **existing scoped memories** (compact: id · type · title) for this
   namespace — so the model reconciles instead of blindly appending.
3. One cheap, **lean** invocation (`model="haiku"`, `skip_pack=True`) with a compact
   view of the turn + those existing memories, instructed to return **strict JSON**:
   an array of ≤2 ops, each `{op, id?, type, scope, title, body}` where
   `op ∈ ADD | UPDATE | SKIP`. `SKIP` = the machine already knows it (dedup). Parse
   defensively — any exception or non-JSON → **log and drop**, never raise.
4. For each `ADD`/`UPDATE`: write a `candidate` row (an `UPDATE` sets its
   `supersedes_id` to the matched existing memory) and emit a **`memory_candidate`**
   event on the source turn (payload = `{item_id, type, scope, title, body}`).

Runs in a **background thread** so it never touches the user's turn latency.

This is the **machine gate** (reconcile: ADD/UPDATE/SKIP, never blind-append — the
Mem0 pattern; skipping it is a known duplicate-generator). The **human gate** is
Keep/Skip (§6). Nothing reaches `active` without passing both.

## 4. Retrieval & injection — tiered, cache-aligned (Approach C)

`retrieve(owner, project, branch, prompt=None)` returns the ordered memory list;
`render_pack` renders it under a token budget in **two tiers**:

- **Resident (always injected, ~800-token budget):** all `user` prefs + the active
  `goal`(s) for this project/branch + `pinned` conventions/decisions/gotchas, then
  newest until the budget is hit. **Deterministic order** (pinned → type priority →
  `created_at`), **no timestamps/UUIDs inside**, budgeted with `count_tokens` (never
  tiktoken).
- **On-demand (semantic, later):** the fuller fact set, reached only when Claude
  asks — via the Phase-3 MCP `recall(query)` tool (§8). Progressive disclosure
  (the `claude-mem` idea): tokens are spent on relevance, not on dumping everything.

**Why the resident block is byte-stable (the token lever).** Prompt caching is a
prefix match: cache **read ≈ 0.1×**, **write ≈ 1.25×** input price, and *any byte
change in the system prefix re-processes the system prompt **and** all message
history uncached*. The pack lands in the `system` block via `--append-system-prompt`,
so if it were re-ranked per prompt it would **bust the cache every turn**. Stable →
it rides the cache at ~0.1× (an ~800-token block: ~1000 tokens written once, then
~80/turn) — trivial against the thousands of re-exploration tokens it saves.
Therefore **semantic re-ranking must not go in the resident tier** — only in the
on-demand tool. Updates are applied at **turn boundaries** (bump `memory_version`),
so mid-turn the string is fixed.

*Caveat:* the bridge drives the Claude **CLI**, which owns `cache_control`/TTL; the
"~0.1× after turn 1" fully lands only when turns fall inside the cache TTL. Across
long human gaps, Claude Code re-writes its system prompt anyway and the pack is a
small, stable rider. Keeping it **small + stable** is the lever we control.

**`sqlite-vec`-ready.** Today `retrieve` ignores `prompt` (recency/pin order). When a
namespace outgrows the budget, the reserved `embedding` column + local embeddings
(default `nomic-embed-text-v2` / `BGE-M3`; Voyage optional) power semantic top-K
behind the *same* seam — no schema migration. `sqlite-vec` is pre-v1 (v0.1.9), which
is exactly why the dependency is deferred.

## 5. Scopes, cascade & staleness

- **`user` scope** = preferences/style (owner only; travel across every repo).
  **`project` scope** = conventions/decisions/goals/gotchas, keyed by path + optional
  branch. Cascade resolution in §1.
- **Volatile goals.** The capture reconcile can propose `UPDATE` (→ `supersede`) so a
  new goal replaces the old rather than accumulating. A **branch-merge lifecycle
  hook** archives (or promotes to project scope) a branch's active goals when the
  branch merges — detected on branch change or via a manual action.
- **Manual freshness.** The Memory view lets you **pin** (never drops from the
  resident tier), **edit**, **delete**, or **archive** anything — the human control
  the staleness problem needs.

## 6. Surfaces

- **Capture card** on all three (Mini App, dashboard, bot inline keyboard). Bot is
  **capture-only**; the Memory *view* is web-only. Rendered from the
  `memory_candidate` event as a **`MemoryCandidateCard`** (title · body — for a
  decision the rationale *is* the body — with **Keep** / **Skip**), styled like
  `PermissionCard`.
- **Memory view** — a Mini App route + a dashboard tab (parallel components, like the
  existing cards): items grouped by scope/project, filter by type, each row with a
  pin toggle, edit, delete, and a provenance link back to `source_turn_id`.
- **Endpoints** on **both** servers, behind existing auth:
  - `GET  /api/memory/items?project=…&branch=…`
  - `POST /api/memory/candidate  {item_id, action:'keep'|'skip'}` — keep activates
    the candidate, and if it carries `supersedes_id`, `supersede`s that memory; skip
    archives the candidate.
  - `POST /api/memory/update  {item_id, title?, body?}`
  - `POST /api/memory/status  {item_id, status}`  (archive/restore)
  - `POST /api/memory/pin     {item_id, pinned}`

## 7. Config, errors, testing

- **Config** (`bridge/config.py`, env idiom): `MEMORY_ENABLE` (default on; off →
  extractor no-ops, pack renders empty), `MEMORY_TOKEN_BUDGET` (default ~800),
  `MEMORY_EMBED` (off; local model name when Approach B activates).
- **Errors:** capture is best-effort and **swallowed** (turn never blocked/delayed);
  injection degrades to an empty pack; bad or cross-owner `item_id` → 404 (as with
  existing session-scoped endpoints).
- **Tests** (`tests/`, stdlib `unittest`):
  - `test_memory_store.py` — CRUD, namespace **cascade resolution**, status
    transitions, pin, `supersede`, owner/project/branch scoping.
  - `test_memory_capture.py` — gating (no output / flag off → no call), strict-JSON
    parse **incl. malformed fallback** (drop, no raise), and the **ADD/UPDATE/SKIP**
    reconcile given existing memories.
  - `test_memory_inject.py` — tier order, budget cap, **byte-stable/deterministic
    render** (same inputs → identical string), user+project+branch merge, `skip_pack`.
  - Frontend gate: `tsc -b` + `vite build` for each app + a visual check of a capture
    card and the Memory view.

## 8. Build sequence

1. `store.py` — table + helpers + cascade resolution + `test_memory_store.py`
   (red→green).
2. `bridge/memory.py` — extractor (reconcile) + `render_pack` (memoized) +
   `retrieve` + `test_memory_capture.py` / `test_memory_inject.py`.
3. Wire the Context Pack into `_base_cmd` (+ `skip_pack`); wire the extractor after
   `notify_turn_done`; emit `memory_candidate`.
4. Endpoints in **both** `miniapp/server.py` and `dashboard/server.py`.
5. `MemoryCandidateCard` + `MemoryView` in `miniapp/web`, then `dashboard/web`.
6. Telegram bot capture card (inline keyboard + callback).
7. `MEMORY_ENABLE` flag + README "Features" bullet.

## Alternatives weighed & future work

- **Not adopted:** Mem0/Zep/Letta (own runtimes/services, separate stores, paid graph
  tiers); `claude-mem` (excellent, but *episodic* activity memory in its own store,
  invisible to the bridge's surfaces, with unverified headless-`-p` hook behavior).
  **Borrowed:** Mem0's ADD/UPDATE/SKIP reconcile; `claude-mem`'s progressive
  disclosure.
- **Approach B (future):** activate `sqlite-vec` + local embeddings behind the
  reserved column / `retrieve` seam when a namespace outgrows the resident budget.
- **Phase 3 (future):** expose the `memories` table as a tiny **MCP `recall(query)`
  server** so Claude can *actively* pull memory beyond the resident pack — one store,
  no duplication; unifies with the tools/skills/MCP track.
- **Teacher-mode:** the spec'd learning-items capture becomes a **second proposer**
  on the same Post-turn Extractor — built once, here.
