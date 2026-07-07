# Graphify map + ponytail controls

Give every surface a **queryable, visual map of the active project** and a
**per-run code-minimalism dial**, powered by two tools already installed on the
machine: [graphify](https://github.com/Graphify-Labs/graphify) (tree-sitter
knowledge graph, CLI + self-contained `graph.html`, zero LLM tokens for code)
and [ponytail](https://github.com/DietrichGebert/ponytail) (Claude Code plugin,
user scope, v4.8.4). The bridge already owns every `claude` spawn and both HTTP
servers, so all four features hang off two seams: subprocess construction in
`runner.py` (env + system prompt) and the `/local/*` / miniapp route tables.

Four features ship together on one substrate:

1. **Map view** — dashboard MAP tab + Mini App map route serving the project's
   `graphify-out/graph.html`, with staleness + build/refresh.
2. **`/map` bot command** — token-free codebase answers in Telegram via the
   graphify CLI.
3. **Ponytail controls** — per-run intensity picker (off/lite/full/ultra) next
   to model/effort/permission, plus REVIEW/AUDIT quick actions.
4. **Graph-seeded memory** — a compact structure pack appended to the system
   prompt alongside the existing project-memory Context Pack.

## Decisions locked (during brainstorming)

- **Shell out to the graphify CLI** (`~/.local/bin/graphify`, pipx). No Python
  library import, no MCP registration (the `/graphify` skill already covers
  in-session use), no custom viz. Graphify's artifacts are the single source of
  truth; everything degrades gracefully when a project has no graph.
- **Ponytail default: `full` everywhere.** The plugin's own default governs
  native sessions; the bridge only sets `PONYTAIL_DEFAULT_MODE` on the `claude`
  subprocess when a run explicitly picks a level. Zero tokens, no config writes.
- **First graph build is always explicit** (MAP tab BUILD, `/map build`, or
  Mini App). Post-turn auto-refresh runs **only** for projects that already have
  a `graphify-out/` — the bridge never silently graphs a repo.
- **Artifacts stay out of user repos**: on a project's first build the bridge
  appends `graphify-out/` to `.git/info/exclude` (repo-local, never committed).
  This repo's own `.gitignore` gains the line as part of the branch.
- **Prompt-cache discipline**: the graph pack contains **no commit hash or
  timestamps** — structure only (subsystems + hubs) — so it is byte-identical
  across turns until a rebuild actually changes the graph's shape. Freshness
  lives in the UI, not the prompt.

## Substrate: `bridge/graphmap.py` (new)

Mirrors the postures already in the codebase: `claude_bin()`-style binary
resolution, `memory.py`-style best-effort (failures → empty/friendly, never
block a turn), `project_config`-style per-project scoping.

- `graphify_bin() -> str | None` — resolve via PATH then `~/.local/bin/graphify`;
  `None` (not an exception) when absent.
- `graph_state(cwd) -> dict` — `{available, exists, built_commit, head, stale,
  building}`. `built_commit` read from `graph.json`'s
  top-level `built_at_commit` field (structured; no markdown parsing);
  `stale` = built_commit ≠ `git rev-parse HEAD`.
- `update(cwd, timeout) -> (ok, message)` — `graphify update .` in `cwd`. One
  `threading.Lock` per project; a held lock returns "already building". Timeout
  300s for explicit builds, 120s for post-turn refreshes. On first successful
  build, append `graphify-out/` to `.git/info/exclude` if missing.
- `explain(cwd, query) -> str` — `graphify explain "<query>"`, output truncated
  to ~3,500 chars with an ellipsis marker.
- `graph_pack(cwd) -> str` — ≤400 estimated tokens (reuse `memory._estimate_tokens`
  convention): top subsystems (community label + a few member hubs) and top hub
  files by degree, parsed from `graphify-out/graph.json`; ends with one line
  telling the model the MAP tab / `graphify explain` exist. Memoized by
  `(path, mtime) → content`; recompute on mtime change but return the cached
  string when content is unchanged (byte-stability).
- `refresh_async(cwd)` — fire-and-forget post-turn refresh, gated on
  `exists`; lock-skipped when a build is in flight.

## 1) Map view

**Dashboard** — an eighth **MAP** tab in the PROJECT ANALYSIS modal
(`AnalyzeModal.tsx`, tab bar OVERVIEW…ISSUES). Tab body:

- Header strip: `BUILT @<short-sha>` + `STALE` badge when behind HEAD; REFRESH
  button (BUILD when no graph yet; disabled + spinner while building; install
  hint when the binary is missing).
- An iframe of `/local/graph/html?project=<rel>` (~2.6 MB self-contained page —
  fine on localhost).
- A one-line EXPLAIN input; results render monospace under it.

**Endpoints** (dashboard `server.py`, existing conventions — GETs Host-gated,
POSTs `X-Dash-Token`-gated):

- `GET /local/graph/state?project=` → `graph_state`
- `GET /local/graph/html?project=` → the file, `text/html`, no-cache
- `GET /local/graph/explain?project=&q=` → `{text}`
- `POST /local/graph/update` `{project}` → `{ok, message}`

**Mini App** — a new `map` route (`routes/map.tsx`) with the same
header/actions; the miniapp server gets the same four routes (initData-gated,
its convention). `graph.html` is fetched with the auth header → blob URL →
iframe (initData can't ride a plain iframe src through the tunnel).

## 2) `/map` bot command (`dispatch.py`)

- `/map` — freshness line + top subsystems (from `graph_state` + a trimmed
  `graph_pack`); hints `/map build` when no graph.
- `/map build` — build/refresh in a daemon thread (the `/server` pattern),
  replying on completion.
- `/map <query>` — `explain()` output in a monospace block, chunked to
  Telegram's message limit.
- HELP text gains one line.

## 3) Ponytail controls

- `runner._base_cmd` callers gain an optional `ponytail` level; both spawn
  paths (blocking `subprocess.run` and the interactive Popen) pass
  `env={**os.environ, "PONYTAIL_DEFAULT_MODE": level}` when set. A
  `normalize_ponytail()` helper in `runner.py` (off/lite/full/ultra; anything
  else → None) is used by both servers' `/run` handlers, mirroring
  `normalize_model_effort`.
- **UI**: a picker beside model/effort/permission in the Mini App composer and
  the dashboard composer; sticky client-side exactly like model/effort
  (no store migration). Unset = plugin default (full).
- **Quick actions**: REVIEW and AUDIT buttons near the composer send
  `/ponytail-review` / `/ponytail-audit` as ordinary prompts.
  *Verification item:* confirm plugin slash commands expand under `claude -p`;
  fallback is the equivalent "Use the ponytail-review skill…" prompt text.

## 4) Graph-seeded memory (`runner.py`)

`_compose_system_prompt` gains a fourth part: `ASK prompt · LOG note · memory
pack · graph pack` — the graph pack from `graphmap.graph_pack(cwd)`, empty when
the project has no graph. `skip_pack` (the memory-capture purity flag) skips it
too. Independent of `MEMORY_ENABLE` — it's structure, not memory.

## Error posture

Every graph/ponytail path is best-effort: missing binary, no git, parse
failures, subprocess errors → friendly state fields, empty packs, or a plain
error message in the reply. Nothing raises into a turn; nothing blocks a run.

## Testing

- `tests/test_graphmap.py` — bin resolution (PATH/fallback/absent), staleness
  derivation, `graph_pack` rendering + budget + memoization from a small
  fixture `graph.json`, explain truncation, first-build `.git/info/exclude`
  append, lock/refresh gating.
- Server tests (existing patterns): the four routes on both servers (auth
  gates, no-graph responses), `normalize_ponytail`, `/run` accepting the param,
  env propagation into the spawned argv/env (mock subprocess).
- `/map` dispatch parsing.
- Suite runs with the known env-isolation caveat (`env -u` for bridge vars);
  web dists rebuilt for both surfaces; end-to-end drive after bridge restart.

## Rollout

Feature branch in a worktree (bridge restarts SIGKILL bridge-hosted sessions —
commit early and often). One commit per feature, substrate first. Both web
dists rebuilt in the final commit; README feature bullets updated. The bridge
restart to load the backend is the user's call, after which `/map`, the MAP
tab, the picker, and the graph pack go live.

## Alternatives weighed

- **graphify-mcp registration** — real in-session graph tools, but touches the
  user's MCP config and duplicates what the installed `/graphify` skill already
  provides; revisit if in-session graph queries become routine.
- **Deep integration** (import graphify, graph in bridge SQLite, custom viz) —
  most control, strictly more code to own against a fast-moving 0.9.x upstream;
  rejected for now.
- **Ponytail via slash-command turns** (`/ponytail lite` as a message) — spends
  a turn and pollutes transcripts; the env-var seam is free and per-run.
