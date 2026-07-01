# Teacher mode + review log

Turn every code-producing turn into a small lesson instead of a black box. The
bridge already sits in the middle of every turn (prompts, assistant text, and
tool calls all flow through the `sessions → turns → events` store), so it is the
natural chokepoint to inject **learning friction** without changing how Claude
Code is driven.

Two halves:

1. **Hybrid capture** — after a turn that actually edited code, a cheap Haiku
   pass proposes 1–2 concepts you just accepted. Each renders as a
   **"📚 Review later? [Keep] [Skip]"** card on whatever surface you're on. Keep
   stores it in a review log; Skip drops it. Catches the drift you'd otherwise
   miss, while keeping you the one who decides.
2. **On-demand Teacher view** — a dedicated view (in both the Mini App and the
   dashboard) listing your kept items grouped by project. Per item, four
   on-demand actions run one-shot, read-only `claude` calls: **Explain**,
   **Explain-back** (you type your understanding, Claude grades it),
   **Quiz me** (one question → graded → mastery bumps), and **Exercise** (a
   by-hand task). No scheduler, no due-dates, no reminders — you study when you
   choose.

Scope explicitly excluded (decided during brainstorming): predict-then-compare,
auto-interrogate, explain-back *gates* on commit/merge, spaced-repetition
scheduling, and proactive Telegram nudges. Those can layer on later; none are
built here.

## What already exists (verified)

- **Store** (`bridge/store.py`) is the single SQLite source of truth, tables
  `sessions → turns → events`. `_connect()` is WAL, autocommit, `Row` factory.
  `init()` runs an idempotent `executescript(_SCHEMA)` plus in-line
  `ALTER TABLE … ADD COLUMN` migrations guarded by `PRAGMA table_info`. New
  tables/columns follow that same idempotent pattern.
- **Events** are typed rows `(session_id, turn_id, seq, type, payload, ts)`.
  Existing `type` values include `assistant`, `text`, `tool_use`,
  `tool_result`, `result`, `error`, and the two **card** types `permission` and
  `question`. Frontends poll the transcript and render a card when they see
  those types. Capture cards reuse this exact mechanism via a **new event type
  `review_candidate`**.
- **Tool events** carry `tool_name` (`runner.py` ~L517–530). A turn "edited
  code" iff it emitted a `tool_use` with `tool_name ∈ {Edit, Write, MultiEdit}`.
- **Runner** (`bridge/runner.py`) exposes `run_blocking(chat_id, prompt,
  resume_id=None, …)` — a one-shot `claude -p` invocation returning text. That
  is the primitive for both the capture pass and the teacher actions. Turn
  completion already fans out through `notify_turn_done(...)`; capture hooks in
  right after a turn finalizes.
- **Config** (`bridge/config.py`) is env-driven module constants
  (`FOO = os.environ.get(...)`, booleans via the `not in ("0","false",…)`
  idiom). A `LEARNING_ENABLE` flag slots in the same way.
- **Frontends are parallel, not shared.** `bridge/miniapp/web` and
  `bridge/dashboard/web` are two separate React 19 + Vite apps that **duplicate**
  components — `PermissionCard.tsx` and `QuestionCard.tsx` each exist in *both*
  trees. There is **no** shared package/workspace. "Shared component" therefore
  means: build a `ReviewCandidateCard` and a `TeacherView` in each app in
  parallel, mirroring the same Mystic-themed markup — exactly how the existing
  cards are kept in sync. Both apps serve a prebuilt `web/dist` (rebuild via
  local bins; `pnpm build` can trip on esbuild; don't restart the bridge
  mid-session — per project memory).
- **HTTP servers** (`miniapp/server.py`, `dashboard/server.py`) are stdlib
  `do_GET`/`do_POST` dispatchers on `/api/*` returning JSON, each with its own
  auth (`validate_init_data` for the Mini App, `?token=` for the dashboard). New
  endpoints are added to both, guarded by each server's existing auth.
- **Tests** live in `tests/test_*.py` (stdlib `unittest`), backend only; the
  frontends have no unit harness — their gate is `tsc -b` + `vite build` +
  visual check.

## 1. Data model — `learning_items` table (`store.py`)

Added to `_SCHEMA` (idempotent `CREATE TABLE IF NOT EXISTS`):

```
learning_items(
  id            TEXT PRIMARY KEY,   -- uuid4
  owner_id      INTEGER NOT NULL,   -- chat_id
  project_path  TEXT NOT NULL,
  session_id    TEXT,               -- source session (nullable)
  source_turn_id TEXT,              -- source turn (nullable)
  title         TEXT NOT NULL,      -- short concept name
  code_snippet  TEXT,               -- the accepted snippet (may be empty)
  why_it_matters TEXT,              -- one line: why review this
  status        TEXT NOT NULL,      -- 'candidate' | 'kept' | 'skipped' | 'archived'
  mastery       INTEGER NOT NULL DEFAULT 0,
  times_reviewed INTEGER NOT NULL DEFAULT 0,
  created_at    REAL NOT NULL,
  last_reviewed_at REAL,
  notes         TEXT                -- freeform, user or grader feedback
)
```

Helpers (mirroring the existing `create_*/get_*/list_*/set_*` naming):
`add_learning_item(...)`, `get_learning_item(id)`,
`list_learning_items(owner_id, project=None, status='kept')`,
`set_learning_status(id, status)`, `bump_mastery(id)` (mastery++,
times_reviewed++, stamp `last_reviewed_at`), `append_learning_note(id, text)`.

## 2. Capture pipeline — `bridge/learning.py` (new)

`propose_review_items(session, turn, assistant_text, edited_files)`:

1. Guard: return immediately unless `config.LEARNING_ENABLE` **and** the turn
   emitted an `Edit`/`Write`/`MultiEdit` `tool_use`.
2. Build a focused prompt: the assistant text + a compact view of the edits, with
   an instruction to return **strict JSON** — an array of at most 2
   `{title, snippet, why_it_matters}` objects naming concepts a learner just
   accepted without necessarily understanding. "Return `[]` if nothing is worth
   reviewing."
3. Call `run_blocking(owner_id, prompt, model="haiku")` (cheap, sessionless).
   Parse JSON defensively: on any exception or non-JSON output, **log and drop**
   — never raise.
4. For each candidate: `add_learning_item(..., status='candidate')` and emit a
   `review_candidate` **event** on the source turn (payload =
   `{item_id, title, snippet, why_it_matters}`).

Runs **fire-and-forget in a background thread** dispatched from the same place
`notify_turn_done` fires, so it never delays the user's turn completion or the
"done" notification.

`teach(item, mode, user_answer=None)` — `mode ∈ {explain, quiz, exercise,
grade}` (explain-back is not a generation mode — it's a UI flow whose submit
calls `grade`). Each builds a mode-specific prompt from the item and calls
`run_blocking(owner_id, prompt, model=<default>)`, run **read-only** in the
item's `project_path` (a prompt that only reads/reasons — it never edits). It
returns generated text. `grade` (used by both explain-back and quiz answers)
takes `user_answer`, returns feedback, and — for a correct quiz answer — the
caller invokes `bump_mastery`.

## 3. Card wiring (capture → Keep/Skip)

- **Event**: `review_candidate` added to a turn's event stream (§1 mechanism).
- **Mini App / Dashboard**: a `ReviewCandidateCard.tsx` in each web tree renders
  when the transcript poll yields a `review_candidate` event — title +
  why-it-matters + snippet, with **Keep** / **Skip** buttons, styled like the
  existing `PermissionCard`.
- **Action endpoint** (both servers): `POST /api/learning/candidate`
  `{item_id, action: 'keep'|'skip'}` → `set_learning_status(item_id, 'kept' |
  'skipped')`. Guarded by each server's existing auth.
- **Telegram bot**: the same candidates render as an inline-keyboard message
  (Keep/Skip callback buttons), handled in the existing dispatch/telegram
  callback path. (Bot is capture-only; the Teacher *view* is web-only.)

## 4. Teacher view (Mini App + dashboard, parallel components)

A `TeacherView` in each web tree (a Mini App route + a dashboard tab/panel,
following how `history`/`issues` are wired in each app):

- **List**: kept items grouped by project, each row showing title, a mastery dot
  (0/1/2/3+), and last-reviewed. Backed by `GET /api/learning/items?project=…`.
- **Detail**: the snippet + why-it-matters, and four action buttons →
  `POST /api/learning/teach {item_id, mode, user_answer?}`, which calls
  `learning.teach(...)` and returns text the view renders as Markdown (reusing
  each app's existing `Markdown.tsx`):
  - **Explain** — concept explanation.
  - **Explain-back** — a textarea; on submit, `mode=grade` returns correction;
    feedback is appended via `append_learning_note`.
  - **Quiz me** — `mode=quiz` returns a question; your typed answer → `mode=grade`
    → feedback; a correct answer bumps mastery.
  - **Exercise** — a small by-hand task (text only; no auto-check in MVP).
- **Archive**: a per-item action → `set_learning_status(id,'archived')` to retire
  mastered items from the list.

Synchronous request/response (each teach call is a few-second `claude` round
trip). Streaming is a deliberate non-goal for the MVP.

## 5. Config & toggle

`config.LEARNING_ENABLE = os.environ.get("LEARNING_ENABLE","1") not in (…)` —
default on; when off, `propose_review_items` no-ops (capture silenced) but the
Teacher view and existing items remain usable.

## 6. Error handling

- Capture is **best-effort and invisible on failure**: any error in the Haiku
  call or JSON parse is logged and swallowed; the user's turn is never blocked,
  delayed, or made to error by it.
- Teach calls are read-only; a failed/empty `claude` response surfaces as an
  inline "couldn't generate — try again" in the view, no state change.
- Bad `item_id` / cross-owner access on any endpoint → 404, same as existing
  session-scoped endpoints.

## 7. Testing

Backend (`tests/`, stdlib `unittest`, following existing patterns):
- `test_learning_store.py` — CRUD + status transitions (candidate→kept/skipped/
  archived), `bump_mastery` increments + timestamps, project/owner scoping in
  `list_learning_items`.
- `test_learning.py` — `propose_review_items` gating (no edits → no call; flag
  off → no call), strict-JSON parsing incl. the malformed-output fallback
  (returns `[]`, logs, no raise), and `teach` prompt construction per mode.

Frontend gate: `tsc -b` + `vite build` for each app + a visual check of a
capture card and the Teacher view.

## Build sequence

1. `store.py` — table + helpers + `test_learning_store.py` (red→green).
2. `bridge/learning.py` — capture + teach + `test_learning.py` (red→green).
3. Wire capture trigger after `notify_turn_done`; add `review_candidate` emit.
4. Backend endpoints in both `miniapp/server.py` and `dashboard/server.py`.
5. `ReviewCandidateCard` + `TeacherView` in `miniapp/web`, then `dashboard/web`.
6. Telegram bot capture card (inline keyboard + callback).
7. `LEARNING_ENABLE` flag; README "Features" bullet.
