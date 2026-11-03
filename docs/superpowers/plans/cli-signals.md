# CLI signals: rows 1, 2, 3, 6 and 7 of the Tools-and-platforms report

Design: `.mystical/design-drafts/cli-signals/` (SPEC.md plus 11 crops), approved 2026-11-03. Live checks against CLI 2.1.316 are in the SPEC's "Live checks" section, with raw logs in `.mystical/cli-signals-check/`.

## Contracts

**Status map** (`runner._build_status` → `/local/running`, shared by the dashboard and the Mini App):
- `state: "background"`: the latest job reported `session_state_changed: idle` after a result, its process is still up, and `background_tasks_changed` lists tasks. Fields: `label`, `bg: [{id, type, desc, since}]`, `peak` (the most tasks live at once), `since` (when the answer landed).
- `state: "working"` can carry `retry: {attempt, max, delay_ms, error, at}` while the CLI retries. The next assistant event clears it.
- `state: "credits"`: the last turn died on `credits_required`. Fields: `slot`, `at`, `buy` (canUserPurchaseCredits), `label`. Lane: NEEDS YOU. Starting a new turn clears it.

**Journaled events:**
- `{"type": "retry", attempt, max, delay_ms, error}`, one per `system/api_retry`.
- `{"type": "ratelimit", status, error_code, resets_at, buy}`, only when `status == "rejected"`. `outcomes.py` turns `credits_required` into `code: "credits"`.

**Usage:** `usage.get_usage(path, max_age)` reads `get_usage` from a short-lived `claude -p` (CLAUDE_CONFIG_DIR per login) instead of `/api/oauth/usage`. `usage.note_event(path, info)` merges live `rate_limit_event`s. `accounts.meter()` adds `read_at`, `live` and `status`. `POST /local/usage/check` forces a read.

**Restart resume:**
- Recovery starts the cut session with no stdin message and with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, which is set on that run only.
- The turn's prompt is `recovery.CONTINUED`, a "⏮ …bridge restart" marker the UI draws as a seam.
- The CLI has accepted when `command_lifecycle: started` or the first assistant event arrives. It has declined when it goes `idle` first, or after 60 s of silence. A declined run journals `{"type": "resume", "declined": true, "why"}` and closes stdin.

**Savers** (`bridge/savers.py`, `savers.json` next to the DB):
- Each saver (`concise`, `subagent_effort`, `trim_tests`) is off, trial or on.
- In trial, the arm is a coin flip seeded by the session id, made on the session's first run.
- Each run applies its savers:
  - `outputStyle: Concise` merged into `--settings`
  - `CLAUDE_CODE_SUBAGENT_EFFORT=medium`
  - a PreToolUse hook (`bridge/trimhook.py`)
- One-shots always get `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`.
- Routes: `GET`/`POST /local/savers`. Results are medians of each arm's first-turn numbers.

## Order (one commit each)
1. runner: session state, background tasks, api_retry and rate-limit events, the status fields, and the env flag.
2. usage: get_usage through the CLI, live events, freshness, the check route.
3. limits: credits_required doesn't park, and gets an exact `resetsAt` park.
4. recovery: native resume and the declined path.
5. savers: settings, arms, per-run flags, the trim hook, results, routes.
6. dashboard: lanes, pill, composer, WORK card retry, limit card, profile menu, Savers fold, seams, prompt tag. Mini App: lane entries for the new states.
7. Suite, web checks, build, then headless captures against staged statuses.

## Skipped
- The bot gets no new command. Credits gets one `_notify` line, like the limit park.
- Mini App routes need nothing: the status map is shared.
