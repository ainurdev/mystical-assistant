# Session run settings: model + permission mode follow the session

Status: design approved 2026-10-04, spec awaiting review.

## Problem

A tester set a session to Fable + Bypass on the laptop dashboard. They then
continued it from the phone, and it ran on Opus and asked for permission.
Switching the Mini App to Fable + Bypass didn't stop the prompts. Root causes,
verified 2026-10-04:

1. **The model picker resets to Opus on every reload and every bridge
   restart, in both apps.** The "snap to an available model" effect
   (`miniapp/web/src/lib/chat.tsx:300`, `dashboard/web/src/App.tsx:1605`) runs
   against the hardcoded pre-load `FALLBACK` list (aliases `opus`/`fable`/…)
   before `/state` delivers the live list (full ids like `claude-fable-5-1`). A
   full id is never in `FALLBACK`, so the pick becomes `opus`, and then
   `claude-opus-5-5` once the live list arrives. The same thing happens when the
   server serves its own alias fallback: on the first `/state` after a restart
   (`models.get_models()` with a cold cache), or while the Models API is down.
   Reproduced headless: a seeded `claude-fable-5-1` reads back as `opus` (Mini
   App) or `claude-opus-5-5` (dashboard).
2. **Model and mode picks are saved per device, not per session.** Each app
   keeps them in its own localStorage and sends them as a per-message override.
   The session row only stores the mode it was created with
   (`store.set_permission_mode` has one caller, `_adopt_native`). Live data:
   session `adc154ec` is stored as `bypassPermissions`, yet its CLI transcript
   shows 10-02 prompts running `bypassPermissions` and every prompt from
   10-03 13:05 on running `auto` on Opus.
3. **A pick can't reach work that's already in motion.** That covers a running
   turn (its `claude` keeps the `--permission-mode` it was spawned with),
   queued prompts (model and mode are frozen at enqueue time), and the bot chat
   (`handle_task` → `run_blocking`, which always uses `EXTRA_CLAUDE_ARGS`
   `acceptEdits` and the CLI's default model).

## Goal

A session keeps the model and permission mode last picked for it, on every
surface: the dashboard, the Mini App, the bot chat, queued prompts and
auto-resumes. A pick made while a turn is running applies to that turn. The
picker never reverts on its own.

Success: set Fable + Bypass on the laptop, then continue the same session from
the phone (Mini App or bot chat). It runs on Fable + Bypass with no permission
cards. Switch to Bypass on the phone while a card is waiting: the card is
approved and the turn stops asking.

Out of scope: effort and ponytail stay per-device. The Mini App SYSTEM tab's
`MODE ·` line (the server fallback, not the session's mode) is left as it is.

## Design

### 1. The session row is the source of truth

- New column `sessions.model TEXT`. It goes in `_SCHEMA`, plus an idempotent
  `ALTER TABLE` in `init()`, which also backfills each existing session from
  its latest turn with a non-null `model`. The change is additive, so master's
  code keeps reading the DB.
- `sessions.permission_mode` already exists and keeps its meaning.
- New `store.set_run_settings(session_id, model=None, permission_mode=None)`
  writes whichever of the two is given.

### 2. Resolving a run's settings (`runner.start_streaming_job`)

- `model = explicit or session["model"]` (or no `--model` if both are empty).
  Today `None` means the CLI default.
- `permission_mode = explicit or session["permission_mode"]`. This is
  unchanged.
- Internal callers keep their explicit values and **do not** write them to the
  session: Rivendell (`bypassPermissions`), trackers (`manual`), next-up
  (`plan`), goals. Only user picks are saved (see 3).

### 3. Saving user picks

- **On send.** The dashboard and Mini App `/run` handlers call
  `store.set_run_settings` with the request's validated model and mode before
  starting the job. This seeds a lazily created fresh session, whose first
  prompt is also its creation.
- **On pick.** Each app gets a new endpoint, `POST /api/session/settings` (Mini
  App) and `POST /local/session/settings` (dashboard), taking
  `{session_id, model?, permission_mode?}`. Values are validated with the
  existing `normalize_model_effort` and `normalize_permission_mode`; anything
  invalid gets a 400 and nothing is saved. The handler saves the values, then
  applies them live (see 4). It returns the saved values.

### 4. Live switch of a running turn (`runner.Job`)

- `Job.set_run_settings(model=None, permission_mode=None)` writes stream-json
  control requests over the existing `_write_stdin`:
  `{"subtype": "set_model", "model": …}` and
  `{"subtype": "set_permission_mode", "mode": …}`. CLI 2.1.280 supports both.
  The bridge already sends `interrupt` this way.
- Switching to `bypassPermissions` also calls `job.respond(rid, behavior="allow")`
  for every pending entry of kind `permission`. Questions (AskUserQuestion)
  stay open, because they ask for a decision, not a permission.
- The endpoint looks up the session's live job. If there is none, or the child
  has already exited, the save is enough and the next turn uses it. If the CLI
  answers a control request with an error, the bridge logs it and the saved
  value stands.

### 5. Frontends (dashboard + Mini App)

- The session payloads (`_session_brief`, and the dashboard's session list)
  gain `model` and `permission_mode`.
  `permission_mode` is reported as the effective interactive mode:
  `permission_mode or MINIAPP_PERMISSION_MODE`.
- When a session is opened or switched to, its `model` and `permission_mode`
  load into the picker. If a poll shows the open session's values changed on
  another device, the picker follows.
- A pick in the picker updates local state and the device default
  (localStorage, as today). If the session exists, the pick also POSTs to the
  settings endpoint. A fresh, not-yet-created session sends its picks with its
  first prompt.
- The "Session" / "Session default" option (`""`) is removed from both
  permission pickers. A stored `""` reads as the device default for new
  sessions.
- Enqueue calls stop sending `model` and `permission_mode`, so a queued prompt
  runs with the session's settings when it starts. The server ignores model and
  mode on enqueue from these two clients. Rivendell queue items still pass their
  own values.
- **Fixing the Opus reset**, in both apps:
  - Don't snap until the server's list has arrived. Use
    `state.models` itself, not `modelOptions()` with its pre-load `FALLBACK`.
  - If the pick isn't in the list, take the first model of the **same family**
    (`claude-fable-5-1` ↔ `fable`, where family is the first id segment after
    `claude-`). Fall back to Opus, then to the first model, only when the
    family isn't offered.

### 6. Bot chat (`runner.handle_task`)

- `run_blocking(..., model=session["model"], permission_mode=session["permission_mode"])`.
  If the session has a mode, `_base_cmd` uses it instead of `EXTRA_CLAUDE_ARGS`
  (the existing non-interactive `permission_mode` branch). A bot-created session
  has no mode, so it still uses `EXTRA_CLAUDE_ARGS`.
- **Security note:** sessions created from the dashboard or Mini App store
  `bypassPermissions` by default, so continuing one from the bot chat now runs
  unattended. That matches what the same allow-listed user can already do from
  the Mini App. Asking modes still can't show cards in the bot chat, so tools
  that need approval are denied there, the same as today's `acceptEdits`.

### 7. Auto-resumes

- `recovery` stops passing the dead turn's model (`t["model"]`) and passes
  `None`, so a resume uses the session's model, including a mid-turn switch. The
  mode already comes from the session. Limit and ladder parks keep the model
  they recorded at park time. ponytail: a model switch made while parked is
  lost; read `session["model"]` at resume time if that ever matters.

## Testing

- pytest (conftest's temp DB):
  - store migration and backfill, plus `set_run_settings`;
  - run resolution falls back to the session's model and mode, and internal
    callers don't write to the session;
  - both `/run` handlers save the request's picks;
  - both settings endpoints save the values, send `set_model` and
    `set_permission_mode` to a fake live job, and auto-allow pending
    permissions (not questions) on a switch to Bypass, with a 400 on invalid
    input;
  - the bot `handle_task` argv carries the session's `--model` and
    `--permission-mode` instead of `acceptEdits`;
  - recovery resumes with `model=None`.
- Frontend: a `.check.ts` for the family snap in each app, covering pre-load
  (no snap), alias list ↔ full-id list, and a family that isn't offered.
- Headless: a seeded `claude-fable-5-1` survives a reload in both apps, using
  the `shot2.mjs` probe that reproduced the bug.
- Live, once: on a scratch bridge (own DB), start a turn in `default`, wait for
  a permission card, switch to Bypass through the endpoint, and confirm the card
  resolves and later tools don't ask.
