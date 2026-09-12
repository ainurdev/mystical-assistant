# Mini App: interactive chat UI + header tabs + persistent session

**Date:** 2026-06-22
**Status:** Approved (design) — user delegated decisions and asked to implement directly
**Area:** `bridge/runner.py`, `bridge/miniapp/server.py`, `bridge/miniapp/web` (React 19 + TanStack Router + React Query + Tailwind)

> Supersedes `2026-06-22-miniapp-persistent-tabs-design.md` (persistence + collapsible
> picker are folded in here alongside the new chat UI and interactive protocol).

## Problem

The Mini App's **Run** tab is a one-shot form: type a prompt, press Send, watch a single run
stream, done. It throws away three things the backend already supports or could support cheaply:

1. **Conversation.** The backend already resumes the prior Claude session on every run
   (`runner._base_cmd` adds `--resume <session_id>`; `state.sessions[chat_id]` is updated after each
   run, and `select` clears it). The UI ignores this — every Send resets `events` and shows only the
   latest run, so there is no visible conversation.
2. **Interactivity.** Runs use `--permission-mode acceptEdits`, so Claude silently edits and never
   asks. There is no way to approve/decline a tool, and no way to answer an `AskUserQuestion`. The
   experience is nothing like the Claude Code TUI.
3. **Durability.** All Run/Server/Preview state is route-local `useState`. Switching tabs unmounts
   the route and discards prompt, attachments, job, and history; a running job stops being polled.
   Telegram frequently kills the webview, losing everything.

Separately, tabs live in a `fixed bottom-0` nav, which collides with a chat composer docked at the
bottom, and the `FolderNavigator` repo picker sits permanently expanded at the top of the Run page.

## Goals

1. **Run is a chat.** A scrollable transcript of turns (user prompt → assistant text/tools →
   result), a composer docked at the bottom. Follow-up messages continue the same Claude session.
2. **Interactive like Claude Code.** When Claude wants to use a permissioned tool, show an inline
   **Allow / Deny** card. When Claude calls `AskUserQuestion`, show the question with selectable
   **option buttons** (single or multi-select). The decision is fed back and the turn continues.
3. **Persistence.** The chat transcript, the active job, the composer draft + attachments, and the
   Server `cmd` / Preview `port` survive tab switches **and** the Mini App being closed/reopened. A
   still-running job resumes streaming on reopen.
4. **Tabs in the header.** Move Run/Server/Preview from the bottom nav into the header (frees the
   bottom for the composer). The repo picker collapses to the header chip.

## Non-goals

- Multiple concurrent chat sessions / a session list. One active chat per user.
- Changing the Telegram **bot text** path. `run_blocking`/`handle_task` stay non-interactive
  (`acceptEdits`); only the Mini App streaming path becomes interactive.
- A persistent long-lived `claude` process. Each turn is a fresh process resumed via `--resume`
  (smallest delta from today's busy/Job model). "Smoothness" is a frontend concern.
- Server-side persistence. All persistence is frontend `localStorage`.

## Backend: interactive streaming protocol

### Verified mechanism (CLI 2.1.185)

Running `claude -p --input-format stream-json --output-format stream-json --verbose
--permission-mode default --permission-prompt-tool stdio` (the `--permission-prompt-tool` flag is
hidden from `--help` but accepted):

- The user prompt is sent on **stdin** as `{"type":"user","message":{"role":"user","content":"…"}}`.
- When Claude wants a permissioned tool, the CLI emits on stdout:
  ```json
  {"type":"control_request","request_id":"<uuid>","request":{
     "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
     "input":{…},"description":"…","permission_suggestions":[…],"tool_use_id":"…"}}
  ```
- We reply on **stdin**:
  - Allow: `{"type":"control_response","response":{"subtype":"success","request_id":"<id>",
    "response":{"behavior":"allow","updatedInput":<input>}}}`
  - Deny: `…"response":{"behavior":"deny","message":"<text shown to Claude as the tool result>"}}`
- `AskUserQuestion` is available headless and surfaces through the **same** `can_use_tool` channel,
  with `input.questions = [{question, header, options:[{label,description}], multiSelect}]`. Feeding
  the answer back via a `deny` whose `message` states the user's choice makes Claude continue
  correctly (verified: it produced "Got it: Blue"). We format the message naturally, e.g.
  `For "Color": Blue`.
- With stream-json **input**, the process stays alive after the `result` event (awaiting more input).
  To end a turn we **close stdin** after the result, which lets the process exit and releases
  `state.busy`. All `can_use_tool` requests for a turn arrive *before* that turn's `result`, so
  closing stdin post-result never strands a pending decision.

### `runner.py` changes

- **`_base_cmd(prompt, chat_id, *, stream, interactive=False)`.** When `interactive`, emit
  `--input-format stream-json --permission-mode default --permission-prompt-tool stdio` and **do
  not** pass the prompt as an arg (it goes via stdin) nor append `EXTRA_CLAUDE_ARGS` (which carries
  the non-interactive `acceptEdits`). `--resume` and `--append-system-prompt` still apply. The
  blocking path and the existing non-interactive streaming path are unchanged.
- **`Job`** gains:
  - `proc: subprocess.Popen | None` and a `_stdin_lock` — so the HTTP thread can write control
    responses while the reader thread reads stdout.
  - `pending: list[dict]` — unresolved `can_use_tool` requests, each
    `{request_id, kind: "permission"|"question", tool_name, summary?, input?, questions?}`.
  - `respond(request_id, *, behavior, message=None, answers=None)` — writes the `control_response`
    to stdin under the lock, removes the entry from `pending`, and appends a resolution event.
- **`_run_streaming`** writes the initial user message to stdin, then reads stream-json lines:
  - `control_request`/`can_use_tool` → build a pending entry + append a transcript event
    (`{type:"permission", …}` or `{type:"question", …}`). For non-AskUserQuestion tools, `summary`
    reuses `_summarize_tool`.
  - On the `result` event → close stdin so the process exits.
  - Existing handling of assistant text, tool_use, tool_result, errors is unchanged.
- **`snapshot(cursor)`** also returns `pending` (the current unresolved requests) so the frontend
  knows what is awaiting a decision without scanning events.

New event types appended to the transcript (in addition to the existing
`text|tool|tool_done|result|error`):

```ts
| { type: "permission"; request_id: string; tool_name: string; summary: string }
| { type: "question"; request_id: string; questions: Question[] }
| { type: "permission_resolved"; request_id: string; behavior: "allow" | "deny" }
| { type: "question_answered"; request_id: string; answers: AnswerSelection[] }
```

### `server.py` changes

- The Mini App run path calls the runner in **interactive** mode. `_api_run` reads an optional
  `fresh: bool` from the body; when true it `state.sessions.pop(chat_id, None)` **before** starting
  the job so the first turn of a new chat does not `--resume`.
- New endpoint **`POST /api/run/<job_id>/respond`** with body:
  ```json
  { "request_id": "…", "behavior": "allow" | "deny",        // permission
    "answers": [{ "header": "Color", "labels": ["Blue"] }]  // AskUserQuestion (optional)
  }
  ```
  Looks up the job, calls `job.respond(...)`. For a question, the backend formats the answer message
  from `answers`. Returns the fresh `snapshot` (so the client updates immediately). 404 if the job
  is gone (stale after a bridge restart).

## Frontend

### A. `usePersistentState` — `src/lib/persistentState.ts`

`usePersistentState<T>(key, initial)` with the `useState` signature (supports updater fns). Hydrates
from `localStorage[key]` (JSON parse, falling back to `initial` on missing/corrupt). Writes on
change in an effect, wrapped in `try/catch` so a `QuotaExceededError` (or absent `localStorage`)
degrades to in-memory. Keys are namespaced + versioned: `miniapp:chat:v1`, `miniapp:server-cmd:v1`,
`miniapp:preview-port:v1`.

### B. `ChatProvider` + `useChat()` — `src/lib/chat.tsx`

Lifts the conversation and polling out of the route so they survive tab switches and reopen. Mounted
in `Layout` (see C). Persisted as one object under `miniapp:chat:v1`:

```ts
interface Attachment { id: string; name: string; dataUrl: string }
interface Turn {
  id: string;
  prompt: string;
  attachments: Attachment[];   // for the user bubble preview
  jobId: string;
  events: RunEvent[];          // assistant stream for this turn
  cursor: number;
  // job status/result/cost/elapsed are read from the live poll for the active turn,
  // and frozen into the turn once it completes.
  status: "running" | "done" | "error";
  result?: string; cost?: number; elapsed?: number;
}
interface ChatState {
  turns: Turn[];
  draft: string;               // composer text
  draftAttachments: Attachment[];
}
```

Hook surface consumed by the Run page:

- `turns`, `draft`, `setDraft`, `draftAttachments`, `addAttachments(files)`, `removeAttachment(id)`
- `activeTurn` (the last turn if `status === "running"`, else null), `isRunning`
- `pending` (the active job's unresolved requests, from the poll snapshot)
- `send()` → `api.run(draft, draftAttachments, project, /*fresh=*/turns.length === 0)`, append a new
  `Turn` with the returned `job_id`, clear the draft. When `turns` is empty (first-ever message or
  the first after **New chat**) the `fresh` flag tells the backend to drop any stored session so the
  turn does **not** `--resume`; otherwise the backend `--resume` continues the conversation.
- `respond(request_id, decision)` → `api.respond(activeJobId, …)`, then merge the returned snapshot.
- `newChat()` → clear `turns` + persisted key. The next `send()` (with `turns` empty) carries
  `fresh: true`, which clears the backend session — so the new chat truly starts fresh. (Changing
  the repo via `select` also clears the backend session, independently.)

**Polling.** A single `useQuery(["run", activeJobId, cursor])` for the active turn appends events,
advances the cursor, and surfaces `pending`/`status`. Because the provider is mounted in `Layout`
it never unmounts on tab navigation, so polling continues in the background. `refetchInterval` is
`1500ms` while `status === "running"`, else `false`. On reopen, if the last turn is `running` the
poll resumes from its persisted `cursor`. If the bridge restarted and the job is gone, the poll 404s
→ stops; the turn is marked `error` and a subtle "Session ended — start a new chat" note shows; prior
transcript stays visible.

**Quota.** The persist serializer tries the full object; on `QuotaExceededError` it retries without
any `attachments`/`draftAttachments` (transcript text is worth more than image previews); if still
failing, it skips the write. In-memory state is unaffected.

### C. Header with tabs + mounted provider — `src/routes/root.tsx`

`Layout` wraps `<Outlet/>` in `<ChatProvider>`. The sticky header becomes **two rows**:
row 1 = project chip (`⚡ <name>` + a busy badge) with a **Change** affordance that toggles the
collapsible folder picker; row 2 = a segmented control of the three tabs (active tab uses
`--tg-button`). The old `fixed bottom-0` nav is removed.

### D. Collapsible repo picker — `src/components/FolderNavigator.tsx`

Reads the selected project from the cached `["state"]` query. Local `expanded` state, default
collapsed when a project exists. The header chip's **Change** toggles `expanded`. Expanded view is
today's full browser (Current folder / Up / dir list / Use this folder), shown as a panel below the
header. On `selectMutation.onSuccess`: invalidate `["state"]`, collapse, and the chat resets to a
fresh session (matching the backend's `select` clearing `state.sessions`).

### E. Chat Run page — `src/routes/run.tsx` + chat components

- A vertical scroll container of **turns**, auto-scrolled to the bottom on new events. Each turn:
  - **User bubble** — right-aligned, `--tg-button` background; shows prompt text + attachment
    thumbnails.
  - **Assistant area** — left-aligned; renders the turn's `events` via the existing `RunStream`
    (text + tool rows), a **Working…** indicator while running, the `FinalResult` card when done,
    and an error banner on failure.
- **Permission card** (`components/PermissionCard.tsx`) — rendered for a `permission` event whose
  `request_id` is still in `pending`: shows `🔧 <tool_name>` + `summary`, **Allow** / **Deny**
  buttons calling `respond`. Once resolved, it shows the outcome (read-only).
- **Question card** (`components/QuestionCard.tsx`) — rendered for a `question` event still pending:
  one block per question with `header`, `question`, and option buttons. Single-select submits on tap;
  multi-select toggles + a **Submit** button. Calls `respond` with `answers`.
- **Composer** (`components/Composer.tsx`) — docked at the bottom: textarea (the persisted `draft`),
  📎 attach, and send (↑). Disabled while `isRunning` or a request is `pending` (you must resolve the
  card first) or the draft is empty. Shows "Working…" while running.
- **New chat** control in the header row (or a small action by the composer) calls `newChat()`.

### F. Server / Preview inputs — `src/routes/server.tsx`, `src/routes/preview.tsx`

Swap `useState("npm run dev")` → `usePersistentState("miniapp:server-cmd:v1", "npm run dev")` and
`useState(3000)` → `usePersistentState("miniapp:preview-port:v1", 3000)`. No other changes.

### API client — `src/lib/api.ts`

- Extend `RunEvent` with the four new variants and add `Question`/`AnswerSelection`/`pending` types.
- `RunStatus` gains `pending: PendingRequest[]`.
- Add `api.respond(jobId, body)` → `POST /api/run/<jobId>/respond`.

## Files

| File | Change |
| --- | --- |
| `bridge/runner.py` | interactive `_base_cmd`; `Job.proc/pending/respond`; stdin control channel; close stdin on result; `pending` in snapshot |
| `bridge/miniapp/server.py` | call runner in interactive mode; `POST /api/run/<id>/respond` |
| `bridge/config.py` | (optional) `MINIAPP_PERMISSION_MODE` default `"default"` |
| `bridge/miniapp/web/src/lib/api.ts` | new event/question/pending types; `api.respond` |
| `bridge/miniapp/web/src/lib/persistentState.ts` | **new** hook |
| `bridge/miniapp/web/src/lib/chat.tsx` | **new** `ChatProvider`/`useChat` (transcript, polling, persistence, respond) |
| `bridge/miniapp/web/src/routes/root.tsx` | two-row header w/ tabs; mount `ChatProvider`; remove bottom nav |
| `bridge/miniapp/web/src/routes/run.tsx` | chat transcript page consuming `useChat()` |
| `bridge/miniapp/web/src/components/Composer.tsx` | **new** bottom composer |
| `bridge/miniapp/web/src/components/PermissionCard.tsx` | **new** Allow/Deny card |
| `bridge/miniapp/web/src/components/QuestionCard.tsx` | **new** option-selection card |
| `bridge/miniapp/web/src/components/FolderNavigator.tsx` | collapsible, toggled from header |
| `bridge/miniapp/web/src/routes/server.tsx` | persist `cmd` |
| `bridge/miniapp/web/src/routes/preview.tsx` | persist `port` |
| `tests/test_bridge.py` | tests for the control protocol (allow/deny/answer, pending, snapshot) |

## Data flow

```
Send turn
  └─ POST /api/run (interactive) → job_id → append Turn → poll ["run",job,cursor]
       └─ can_use_tool → pending + permission/question event → card shown
            └─ user taps Allow/Deny/option → POST /api/run/<job>/respond
                 └─ control_response → stdin → tool proceeds → … → result → close stdin → exit
Follow-up turn
  └─ POST /api/run again → backend --resume continues the session → new Turn appended
Tab switch (Run→Server→Run)
  └─ Layout stays mounted → ChatProvider keeps polling → return shows live transcript
Reopen Mini App
  └─ hydrate chat:v1 → resume poll of active job (or "session ended" if job is gone)
Change repo
  └─ select success → invalidate ["state"] → picker collapses → next turn starts fresh session
```

## Error handling & edge cases

- **localStorage quota** — serializer drops attachments, then skips; in-memory unaffected.
- **Corrupt/old persisted JSON** — `usePersistentState` falls back to `initial`.
- **Stale job after bridge restart** — poll 404s, stops; turn marked `error`; "session ended" note;
  transcript kept; **New chat** clears it.
- **User closes app with a pending permission** — process stays alive holding `busy` until the
  `RUN_TIMEOUT` watchdog kills it; on reopen the poll re-shows the pending card so it can be resolved
  before the watchdog fires.
- **Deny semantics** — a denied permission feeds Claude a deny message as the tool result; Claude
  continues (may pick another approach or stop). For a question, the deny `message` carries the
  user's selection, which Claude treats as the answer.
- **No `localStorage`** — hook try/catches reads too; app degrades to in-memory.

## Verification

- `python -m pytest tests/` passes, including new control-protocol tests.
- `npm run build` (tsc + vite) passes with no type errors.
- Manual, in the Mini App:
  1. Send a prompt that edits a file → an **Allow/Deny** card appears; Allow → the edit happens and
     the turn finishes; the decision shows in the transcript.
  2. Ask Claude to ask a multiple-choice question → a **question card** with option buttons appears;
     tapping an option continues the turn with that answer.
  3. Send a follow-up → it continues the same conversation (transcript grows, context retained).
  4. While a turn streams, switch to **Server** and back → transcript intact and still updating.
  5. Type a Server `cmd` / Preview `port`, switch tabs → values preserved.
  6. Fully close and reopen → transcript, draft, server cmd, preview port restore; a running turn
     resumes streaming; a pending card is still actionable.
  7. **New chat** → transcript clears and the next message starts a fresh session.
