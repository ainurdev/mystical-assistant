# Context-aware "start a new session?" guardrail

Before a substantial pasted prompt resumes the **current** session, a fast LLM
check decides whether it actually belongs there. If it looks unrelated, the
prompt is **held** (not run) and the user picks **[Start new session]** (the task
is routed there, pre-titled) or **[Continue here anyway]**. Dashboard + Mini App
only — the Telegram bot plain-text path is unchanged.

This is a relevance *check*, not model training. Nothing about local Claude is
fine-tuned; it's a stateless classification call plus a confirm card.

## What already exists (verified)

- **Sessions** are keyed by `chat_id + project`, carry `title` and
  `claude_session_id`; a plain-text/composer prompt resumes the active/latest
  session (`dispatch.handle_task`, dashboard `_run`, miniapp `_run`).
- **Turn prompts are stored**: `turns.prompt` (`store.start_turn`), so a session's
  recent user prompts + `title` are directly queryable — enough context for the
  check without reading assistant text/events.
- **Run path is shared in shape**: dashboard `POST /api/run` and miniapp
  `POST /api/run` both build a prompt + optional `session_id` and call
  `runner.start_streaming_job(...)`, returning `{job_id, session_id}`.
- **Both pieces the "new session" path needs already exist**: `POST /local/sessions`
  (dashboard) / `POST /api/sessions` (miniapp) create a session;
  `store.set_title` pre-titles an empty session; the CLI is invoked statelessly as
  `claude -p <prompt> --output-format json` in `run_blocking` (template for the
  check call).

## 1. Relevance module — `bridge/relevance.py`

One entry point:

```python
def check_relevance(session: dict, prompt: str) -> dict:
    # -> {"related": bool, "reason": str, "suggested_title": str | None}
```

- **Context**: `session["title"]` + the last `RELEVANCE_CONTEXT_TURNS` (≈3) turn
  prompts for that session (`SELECT prompt FROM turns WHERE session_id=? ORDER BY
  seq DESC LIMIT N`), each truncated to ~400 chars.
- **Call**: `claude -p <classifier-prompt> --output-format json --model
  $RELEVANCE_MODEL`, **stateless** (no `--resume`), tools/MCP disabled for
  startup speed (e.g. `--strict-mcp-config` with an empty config and no
  `--append-system-prompt` extras), `timeout=$RELEVANCE_TIMEOUT`.
- **Classifier prompt** (system + input): "An ongoing Claude Code session has the
  context below. A new task just arrived. Decide if the new task **continues this
  session** or is a **different piece of work**. Reply with ONLY JSON:
  `{\"related\": bool, \"reason\": \"<one short sentence>\", \"suggested_title\":
  \"<3-6 word title for the new task, or null>\"}`." `suggested_title` pre-names a
  new session if the user splits it off.
- **Parse**: read `result` from the CLI JSON envelope, then `json.loads` the
  model's reply. Be lenient (strip code fences).
- **Fail-open**: any non-zero exit, timeout, empty output, or parse failure →
  return `{"related": True, "reason": "", "suggested_title": None}`. A flaky check
  never blocks real work.

## 2. Gating (shared helper, before `start_streaming_job`)

`relevance.should_check(session, prompt, force) -> bool` — returns True only when
**all** hold:

- `config.RELEVANCE_CHECK` is on,
- `force` is falsy,
- the session already has ≥1 prior turn (nothing to be unrelated to otherwise),
- the prompt is "substantial": `len(prompt) >= RELEVANCE_MIN_CHARS` **or** it
  contains a newline (multi-line paste).

Short follow-ups ("yes", "continue", "fix that") and brand-new/empty sessions
never trigger the check.

## 3. Protocol / UX — reuse `POST /api/run` with a `force` flag

Both servers' `_run` gain the same pre-step (extract into a shared helper so
dashboard + miniapp stay identical):

1. Resolve `session` for the incoming `session_id` (existing logic).
2. If `should_check(session, prompt, body.get("force"))`:
   `r = check_relevance(session, prompt)`.
   - If **not** `r["related"]`: **do not start a job**. Return
     `{"suggest_new": true, "reason": r["reason"], "suggested_title":
     r["suggested_title"]}` (HTTP 200). The original `prompt`/`images` stay
     client-side; nothing is persisted.
3. Otherwise (related, or check skipped): start the job as today, return
   `{job_id, session_id}`.

Client (`api.ts` `run(...)`) returns the union `{job_id,...} | {suggest_new,...}`.
On `suggest_new`, the composer renders a **hold-and-confirm card** instead of
sending:

- Copy: "This looks unrelated to **<current session title>** — <reason>."
- **[Start new session]** → `createSession(project, { title: suggested_title })`
  then `run({ ...originalArgs, session_id: newId, force: true })`; switch the UI to
  the new session.
- **[Continue here anyway]** → `run({ ...originalArgs, force: true })` (bypasses
  the check; **no second LLM call**).
- **[Dismiss]** → drop the card, leave the prompt in the composer for editing.

`createSession` accepts an optional `title`; servers call `store.set_title` on the
freshly created empty session.

## 4. Config — `bridge/config.py`

| Var | Default | Meaning |
|---|---|---|
| `RELEVANCE_CHECK` | `1` | master on/off (no-op everywhere when off) |
| `RELEVANCE_MODEL` | `haiku` | model for the check call |
| `RELEVANCE_MIN_CHARS` | `280` | substantial-prompt threshold |
| `RELEVANCE_CONTEXT_TURNS` | `3` | recent turn prompts included as context |
| `RELEVANCE_TIMEOUT` | `25` | seconds before the check fails open |

## 5. Frontend card (shared)

A single presentational component (`SuggestNewSessionCard`) used by both surfaces
(they share the design system / tokens). Props: `currentTitle`, `reason`,
`suggestedTitle`, `onStartNew`, `onContinue`, `onDismiss`. Rendered in the
composer's pending-action area; matches the existing permission/AskUserQuestion
card styling.

## 6. Testing

- **relevance.py** (CLI mocked, no live model): `should_check` truth table
  (off / forced / no prior turns / short / multi-line / long); JSON parse incl.
  code-fenced reply; **fail-open** on timeout, non-zero exit, empty output, bad
  JSON.
- **HTTP**: against running servers — an unrelated prompt on a session with
  history returns `suggest_new` and starts **no** job; the same prompt with
  `force:true` starts a job; a short prompt skips the check (job starts directly).
- **Frontend**: both clients `tsc -b && vite build`; manual paste of a clearly
  unrelated task on dashboard + Mini App.

## Caveats

- **Latency**: spawning `claude` even on haiku has real cold-start cost —
  **measured 8–15s** at implementation time (the 2–4s estimated here was
  optimistic), hence `RELEVANCE_TIMEOUT=25`: a tighter bound just fails open on
  every check and makes the guardrail a no-op. Gating to substantial prompts keeps
  it off follow-ups. If the wait is intolerable, revisit (e.g. a persistent
  lightweight checker process). Out of scope for v1.
- Guards only the **current-session boundary**; it does not suggest *which
  existing* session a task best fits. Possible later extension, intentionally out
  of scope.

## Scope guard (YAGNI)

- Telegram **bot** plain-text path untouched (no inline-keyboard card in v1).
- No persistence of declined/accepted suggestions, no learning loop, no metrics.
- No "move existing turns" — the check happens **before** the prompt is sent, so
  there's nothing to move; routing simply targets a fresh session.
- No new endpoints — reuse `/api/run` (+`force`) and the existing create-session
  endpoints.
