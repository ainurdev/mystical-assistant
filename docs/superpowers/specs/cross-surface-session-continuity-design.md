# Cross-surface session continuity (design)

**Date:** 2026-06-23
**Status:** Approved — ready for implementation
**Builds on:** [2026-06-23-unified-sessions-dashboard-design.md](2026-06-23-unified-sessions-dashboard-design.md)

## Goal

Start a Claude session on **any** surface — the desktop dashboard, the Telegram
Mini App, the Telegram bot, or **Claude Code running natively in VSCode/terminal**
— and continue it from any other surface, without caring where it started. Picking
up a native session on the phone shows its **full prior transcript** and lets you
keep going. Sessions started from the dashboard and Mini App run with **full
permission** (autonomous, no Allow/Deny prompts).

## Background — what holds sessions together today

- The three bridge surfaces (bot, Mini App, dashboard) already share one SQLite
  store at `~/.bridge_state/bridge.db` ([store.py](../../../bridge/store.py)):
  `sessions` → `turns` → `events`. Continuity rides on
  `sessions.claude_session_id` (Claude's native UUID), re-fed as `--resume` each
  turn ([runner.py:90-101](../../../bridge/runner.py#L90-L101)).
- **Single user.** All rows are owned by one `chat_id` (the Telegram id, which
  also resolves as `DASH_CHAT_ID`). The "owner mismatch" that would silo the
  dashboard from the phone does **not** apply here — we rely on the single-owner
  invariant and do not build multi-user logic.
- **Native Claude Code sessions are invisible to resume.** They live only as
  `~/.claude/projects/<enc-cwd>/<uuid>.jsonl`. The bridge merely peeks at *live*
  ones for display ([machine.list_running()](../../../bridge/machine.py#L83-L104));
  it never records, links, renders, or resumes them. After VSCode closes they
  vanish from the bridge entirely.
- **Latent bug:** 3 of 4 existing bridge sessions have `claude_session_id = NULL`,
  so even bridge-side resume is currently unreliable.

Key facts established by inspection:
- The native JSONL is a **superset**: because the bridge drives `claude`, which
  writes the same JSONL, bridge-run sessions appear there too. So `(native UUID,
  cwd)` is a universal identity for *every* session.
- The true `cwd` is recoverable from any `user`/`assistant` JSONL record's `cwd`
  field — no need to reverse Claude's lossy `/`→`-`,`_`→`-` directory encoding.
- `sessionId` in the JSONL = filename UUID = `--resume` argument =
  `sessions.claude_session_id`.

## Approach — Hybrid (index + on-demand JSONL transcript)

The store holds a **unified session index** (one row per session, bridge- or
native-origin, keyed by `claude_session_id`). History is rendered **on demand from
the JSONL** via one translator — no bulk import. Live runs keep streaming through
the existing pubsub path; the JSONL is the durable record afterward. Each origin
has exactly one authoritative history source, so nothing diverges.

## 1. Data model

Add three columns to `sessions` (idempotent `ALTER TABLE` migration in
[store.init()](../../../bridge/store.py#L70), matching the existing `turns.model`
migration pattern):

| Column | Values | Purpose |
|---|---|---|
| `origin` | `dashboard` \| `miniapp` \| `bot` \| `vscode` \| `terminal` | Where the session started. Drives the surface badge **and** the permission default. |
| `cwd` | absolute path | The session's working dir. Resume runs `claude --resume <uuid>` here; recovered from the JSONL for native rows. |
| `permission_mode` | one of `MINIAPP_PERMISSION_MODES` | Per-session permission posture, carried on every turn and every cross-surface resume. |

Identity rules:
- **Native rows:** `id = claude_session_id = <native uuid>`, `project = rel(cwd)`,
  `chat_id =` the single owner, `updated =` JSONL mtime, `title =` first user
  message, `origin = vscode|terminal`.
- **Bridge rows:** unchanged `id` (uuid4 hex); `origin` set to the creating surface.
- **Dedup by `claude_session_id`.** Legacy bridge rows with NULL
  `claude_session_id` are best-effort backfilled by the scanner (match a JSONL with
  the same `cwd` and closest creation time); ambiguous matches are left alone
  (worst case: a duplicate index entry for an old empty session).

New/changed store functions: `upsert_native_session(...)`, `set_cwd`,
`set_permission_mode`, and `create_session(..., origin, cwd, permission_mode)`.
`list_sessions*` and `transcript` gain no new query shape (the new columns ride
along in `SELECT *`).

## 2. Discovery scanner — `bridge/native.py` (new)

1. Enumerate `~/.claude/projects/*/*.jsonl` **and** live sessions from
   `machine.list_running()`.
2. Per transcript: `sessionId` from the filename; scan for the first record with a
   `cwd` field to recover the true working dir; `title` from the first `user`
   message; `updated` from mtime.
3. **Filter:** keep only `cwd` under `BASE_PATH` (your `~/projects`); skip the rest
   (so `/tmp/ccprobe*` etc. drop out).
4. **Upsert** a metadata-only index row per session (no transcript import). Dedup by
   `claude_session_id`; refresh `updated`/`title`/live-status for existing rows.
5. Trigger: a **debounced refresh** whenever a surface requests a session list, so a
   session just started in VSCode appears. Cheap (metadata only, a few dozen files).

Isolation: depends only on `config.BASE_PATH`, `browser.rel`,
`machine.list_running`, and the new `store.upsert_native_session`.

## 3. Transcript rendering — `bridge/transcript_jsonl.py` (new)

The single JSONL→message translator:
- Input `(uuid, cwd)` → resolves the `.jsonl` path → walks records in file order →
  emits the **existing transcript event vocabulary** (the shape
  [store.transcript()](../../../bridge/store.py#L255) returns) so the
  dashboard/Mini App renderers work **unchanged**.
- Mapping: `user`→user message (string content or `tool_result` blocks);
  `assistant`→assistant blocks (`thinking`/`text`/`tool_use`) with `model`/`usage`;
  control records (`queue-operation`, `file-history-snapshot`, `mode`,
  `last-prompt`) skipped; `attachment`→images; sidechains (`isSidechain`) collapsed
  in v1. The exact block→event table is pinned during implementation by reading the
  store event types and the React renderer.
- Supports a `cursor` (line offset) for incremental polling.

**Read rule** — one dispatch point for "load transcript", keyed by `origin`:
- `origin` is a bridge surface → `store.transcript()` (today's path).
- `origin` is native → `transcript_jsonl`.
- **Live runs are orthogonal:** an in-flight turn streams over pubsub regardless of
  origin; on settle, a reload renders from the origin's authoritative source.
  Because a bridge-driven resume of a native session appends to that same JSONL, the
  JSONL stays complete — no second copy to reconcile.

## 4. Resume routing & concurrency

**Unified continue:** every surface resumes by passing the session row id. The
runner resolves the row and continues from **the session's own stored context**:
working dir = `row.cwd` (validated under `BASE_PATH`), `--resume
row.claude_session_id`, `--permission-mode row.permission_mode`. This is a focused
[runner.py](../../../bridge/runner.py) change so `start_streaming_job` /
`ensure_session` honor the session's stored `cwd` + `permission_mode` instead of
deriving cwd from chat state ([runner.py:501](../../../bridge/runner.py#L501)).

**Live-session takeover guard:** before continuing, check `machine.list_running()`
for a live process on the same UUID. If it is currently open in VSCode/terminal,
**block** the continue with a clear message and offer **read-only transcript view**;
do not co-write the JSONL. The existing busy-lock still prevents two bridge turns on
one session.

## 5. Listing unification & badges

- **Dashboard** already has cross-project `list_sessions_all`; responses now carry
  `origin`/`permission_mode`, and the UI shows an origin badge.
- **Mini App** gains an **all-sessions** view: a `GET /api/sessions` (no `project`
  param) → `store.list_sessions_all(chat_id)`, plus the frontend list. This is what
  lets the phone *find* a session started on the dashboard or in VSCode.
- Both lists include native rows and trigger the debounced discovery refresh.

## 6. Permissions

- Sessions **created from the dashboard or Mini App** default to
  `permission_mode = 'bypassPermissions'` (full autonomy, no Allow/Deny cards).
- The mode is **persisted on the session** and read by the runner on every turn and
  resume, so continuing from any surface keeps it. A per-run override may still dial
  it down for a single message.
- The bot path is unchanged (already `--dangerously-skip-permissions` via
  `EXTRA_CLAUDE_ARGS`).
- **Security note (accepted):** the Mini App is exposed via the public the tunnel client
  tunnel (gated by signed `initData` + `ALLOWED_CHAT_IDS`). Full permission removes
  the last interactive guardrail on that surface — consistent with the bot's
  existing posture on this single-user, locked-down machine.

## 7. claude_session_id capture hardening

Ensure `run_blocking` and `start_streaming_job` reliably persist the
claude-emitted `session_id` on completion (root-cause the 3/4 NULL rows). The
scanner additionally backfills legacy NULLs best-effort.

## Components & files

| Unit | File | Responsibility |
|---|---|---|
| Schema + index fns | `bridge/store.py` | migration; `upsert_native_session`, `set_cwd`, `set_permission_mode`; `create_session` origin/cwd/permission args |
| Discovery scanner | `bridge/native.py` (new) | enumerate disk+live native sessions under BASE_PATH; upsert index rows |
| JSONL translator | `bridge/transcript_jsonl.py` (new) | JSONL → existing event vocabulary, with cursor |
| Resume routing | `bridge/runner.py` | resume by session's stored cwd/permission/claude_session_id; capture fix |
| Transcript dispatch + endpoints | `bridge/dashboard/server.py`, `bridge/miniapp/server.py` | origin-keyed transcript; Mini App all-sessions; discovery refresh; permission default; takeover guard |
| UI | `bridge/dashboard/web`, `bridge/miniapp/web` | origin badges; Mini App all-sessions view; native transcript render |

## Testing strategy

- **store**: migration is idempotent; new columns default sanely on old DBs; dedup
  by `claude_session_id`.
- **transcript_jsonl**: unit tests against a real captured `.jsonl` fixture →
  asserts the event vocabulary matches what `store.transcript()` produces for an
  equivalent conversation; cursor advances.
- **native scanner**: temp `~/.claude/projects` tree → correct cwd recovery, BASE_PATH
  filtering, dedup, backfill behavior.
- **runner**: resume uses the session's stored cwd/permission, not chat state;
  takeover guard blocks a live UUID.
- **end-to-end**: against the running bridge — start a session in VSCode under
  `~/projects`, confirm it appears and renders full transcript in the dashboard and
  Mini App, continue it from the phone, confirm `--resume` lands in the right cwd.

## Out of scope (v1)

- Native sessions whose cwd is outside `BASE_PATH` (chosen: `~/projects` only).
- Multi-user / cross-owner sharing.
- Live co-watching of an in-progress VSCode session (we block takeover instead).
- Full sidechain/subagent rendering (collapsed in v1).
