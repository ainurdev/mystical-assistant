# Mini App: interrupt/stop, model + effort controls, shadcn input

**Date:** 2026-06-23
**Status:** Approved — user said "Implement it" after taking all recommended defaults
**Area:** `bridge/runner.py`, `bridge/miniapp/server.py`, `bridge/config.py`,
`bridge/miniapp/web` (React 19 + TanStack + Tailwind v4 + shadcn/ui)

## Problem

The Mini App chat runs a turn to completion with no way to stop it, always uses the
default model at the default effort, and the composer is a cramped single-row textarea.
Users want to (1) **interrupt** a running turn — to add detail or just halt it,
(2) pick the **model** and **reasoning effort** per the CLI's `--model`/`--effort`
flags, and (3) get a **more readable chat input**. We also adopt **shadcn/ui** for the
new controls, themed onto the existing purple palette.

Verified against CLI `2.1.185`: `claude -p` accepts `--effort <low|medium|high|xhigh|max>`
and `--model <opus|sonnet|haiku|…>`. The interactive run is a live `subprocess.Popen`
with an open stdin control channel, so an interrupt control request can be written to it.

## Decisions (all recommended defaults)

1. **Interrupt** — one **Stop** button, graceful: send an interrupt control request, fall
   back to terminate/kill if it stalls. The session is preserved, so the next message
   resumes (that is the "add details" flow). No live message-queue.
2. **shadcn** — selective + infra: set up `cn`, the `@/` alias, `components.json`, and map
   shadcn tokens onto the purple vars; use shadcn primitives for the new controls and
   re-skin the existing Button/Card/Banner to match.
3. **Models** — Opus 4.8 (default), Sonnet 4.6, Haiku 4.5.
4. **Controls** — `Model · Effort` chips in the composer toolbar, persisted to
   `localStorage`, applied to every message until changed. Effort default = unset (CLI
   default); levels low/medium/high/xhigh/max.

Scope guard: model/effort and interrupt apply to the **interactive Mini App path only**.
The bot's plain-text path (`run_blocking`) is unchanged.

## Backend

### `config.py`
- `MINIAPP_MODELS = {"opus", "sonnet", "haiku"}` — allowed `--model` aliases.
- `MINIAPP_EFFORTS = {"low", "medium", "high", "xhigh", "max"}` — allowed `--effort` levels.

### `runner.py`
- **`_base_cmd(prompt, chat_id, *, stream, interactive=False, model=None, effort=None)`** —
  append `--model <model>` and/or `--effort <effort>` when provided (callers only pass them
  on the interactive path; the blocking path passes neither, so it is unchanged).
- **`Job`** gains `interrupted: bool = False` and:
  - **`interrupt() -> bool`** — returns `False` if `status != "running"` or `proc is None`.
    Else set `interrupted = True`, write
    `{"type":"control_request","request_id":<uuid>,"request":{"subtype":"interrupt"}}`
    to stdin (under `_stdin_lock`), and arm a daemon timer (`INTERRUPT_GRACE = 5.0s`) →
    `proc.terminate()`, then a second timer (`INTERRUPT_KILL = 2.0s`) → `proc.kill()` if
    still alive. The timer is stored on the job and cancelled in `_run_streaming`'s finally.
- **`_handle_event` result** — `status = "done" if (not is_error or job.interrupted) else "error"`.
- **`_run_streaming` finalize** (after the stdout loop):
  - if `job.interrupted`: force `status = "done"` (if still running) and append a single
    `{"type":"stopped"}` event.
  - elif `status == "running"`: existing stderr/exit-code error path (unchanged).
- **`start_streaming_job(..., model=None, effort=None)`** threads both into `_run_streaming`
  → `_base_cmd`.

New transcript event: `{ type: "stopped" }`.

### `server.py`
- **`_api_run`** reads `model`/`effort` from the body. Validate: `model and model not in
  config.MINIAPP_MODELS` → `400`; `effort not in config.MINIAPP_EFFORTS` → drop (treat as
  unset). Pass both to `start_streaming_job`.
- **`POST /api/run/<job_id>/interrupt`** — routed before `/respond` and `/api/run`. Looks up
  the job (404 if gone), calls `job.interrupt()` (409 if not running), returns the snapshot
  (cursor from the optional body `cursor`).

## Frontend

### shadcn infra
- Deps: `clsx`, `tailwind-merge`, `class-variance-authority`, `@radix-ui/react-dropdown-menu`.
- `src/lib/utils.ts` → `cn()`. `@/*` → `src/*` in `tsconfig.app.json` (`baseUrl`+`paths`) and
  `vite.config.ts` (`resolve.alias` via `fileURLToPath`). `components.json` for future adds.
- `index.css`: add shadcn tokens (`--background --foreground --primary(+-foreground)
  --secondary(+) --muted(+) --accent(+) --popover(+) --input --ring --radius`) mapped onto the
  purple vars, exposed to utilities via `@theme inline { --color-*: var(--*) }`.

### Components
- Move `components/ui.tsx` → `components/ui/index.tsx` (imports `./ui` / `../components/ui`
  still resolve to the directory index), re-skinned with `cn` + `cva` (same purple look).
- Add `components/ui/textarea.tsx` and a trimmed `components/ui/dropdown-menu.tsx`
  (DropdownMenu + Trigger + Content + Label + Separator + RadioGroup + RadioItem).
- **`Composer`** — three zones: a toolbar row with two dropdown chips
  (`✨ <model> ▾`, `Effort: <level|Auto> ▾`); a full-width **auto-growing** textarea
  (~1→6 rows, `text-[15px]`, comfortable line-height, violet focus ring); a bottom row with
  📎 attach (left) and **Send ↑** which becomes **Stop ■** while running (right). Textarea
  stays enabled while running so the user can pre-type the follow-up.

### State / API
- `api.run(prompt, images, project, fresh, model?, effort?)` — adds `model`/`effort` to the body.
- `api.interrupt(jobId, cursor?)` → `POST /api/run/<id>/interrupt`.
- `RunEvent` gains `{ type: "stopped" }`.
- `ChatProvider`: `usePersistentState("miniapp:model:v1", "opus")` and
  `usePersistentState("miniapp:effort:v1", "")` (""=Auto). Expose `model/effort/setModel/
  setEffort` and `stop()` on the context. `send()` passes `model` and `effort || undefined`.
  `stop()` calls `api.interrupt(activeJobId, cursor)` and merges the snapshot.
- `RunStream`: `case "stopped"` → a subtle chip "Stopped — send a message to continue."
  (lucide `CircleStop`).

## Error handling & edge cases
- Interrupt on a finished/absent job → 409/404; on a `proc is None` race → no-op `False`.
- Bad model → 400 before the job starts; bad effort → silently dropped.
- Interrupt that the CLI honors emits its own `result` (possibly `is_error`); `interrupted`
  forces `status="done"` and we still append one `stopped` marker.
- Kill-without-result path: no `result` event, `stopped` marker added, `status="done"`,
  `session_id` (captured from the early init event) persists → next message resumes.
- Persisted model/effort survive reopen via `usePersistentState`.

## Testing
- `tests/test_bridge.py`:
  - `_base_cmd` includes `--model`/`--effort` when passed; omits them otherwise (blocking
    path still `["claude","-p","hi", …]`).
  - `Job.interrupt()` on a running job writes the interrupt control request and sets
    `interrupted`; returns `False` when not running.
  - result with `is_error` but `interrupted` → `status == "done"`.
- Frontend: `npm run build` (tsc + vite) clean.
- Manual: pick model/effort → send; Stop mid-run → "Stopped" chip, turn ends; follow-up
  resumes the same conversation; values persist across reopen.
