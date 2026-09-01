# Cross-project shared tasks — design

2026-09-01 · drafted, awaiting approval

## Problem

One piece of work often lives in two repos. You change an endpoint in
`mystical-assistant` and the client in `apex` has to change with it; you rename a
field in a backend and a mobile app stops compiling. Today the bridge has no idea
those two changes are one task. You notice the coupling yourself, open the other
project, start a session, and re-type the context the first session already had.
Two sessions that know nothing about each other, and a hand-carried summary
between them that is stale the moment either side moves.

The bridge is already capable of the mechanical half. `runner.start_streaming_job`
takes a `project` and runs there; it claims only that session's run slot, so a
turn in `/apex` and a turn in `/mystical-assistant` run at the same time without
either blocking the other. `POST /local/sessions` creates the session. What is
missing is (a) something that *notices* and pulls the trigger, and (b) a place for
the two sessions to leave each other messages.

## Decisions taken before this spec

Four, so the alternatives are on the record rather than re-litigated:

- **The model pulls the trigger, not a classifier.** A `Delegate` tool the model
  calls when it hits a cross-repo boundary costs nothing on the prompts that
  aren't cross-repo. The alternative — widening `relevance.py`'s pre-turn
  one-shot, which already classifies substantial prompts, to also decide "does
  this touch another repo" — taxes prompts that are nothing of the sort with
  latency and tokens to catch a minority case, and is wrong in both directions
  when it guesses.
- **The second session starts working immediately.** Creating it parked behind a
  tap is safer and was rejected: the point of the feature is that you don't have
  to be looking. Every start is announced on Telegram, so "immediately" is never
  "silently".
- **The link is two-way and live.** Each side can read the other's state and
  write to a shared scratchpad. A one-way "B reports back to A when done" was
  the cheaper option and does not survive the real case, where B discovers the
  API shape A chose is wrong and has to say so before finishing.
- **Delegate always creates a fresh session.** `start_streaming_job` with
  `session_id=None` resolves to the project's *current* session, which would drop
  a handoff prompt into whatever unrelated work is open there. The tool creates
  explicitly and passes the new id.

## 1. Data (`bridge/store.py`)

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id      TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  created REAL NOT NULL,
  notes   TEXT NOT NULL DEFAULT '[]',   -- [{session, project, ts, text}]
  pokes   INTEGER NOT NULL DEFAULT 0    -- budget spent; see §4
);
ALTER TABLE sessions ADD COLUMN task_id TEXT;   -- NULL = not part of a task
CREATE INDEX IF NOT EXISTS ix_sessions_task ON sessions(task_id);
```

Membership is the `task_id` on the session row — sessions sharing one are the
task's members. No join table: a session belongs to at most one task, and a task
that outlived both its sessions is not a thing anyone asked for.

`notes` is one JSON column rather than a `task_notes` table for the reason
`sessions.goal` is one column: the list is only ever read whole and appended to,
and it is capped (last 50; a scratchpad, not an archive). Appends run inside the
`BEGIN IMMEDIATE` transaction `store.py` already uses for event-sequence
allocation, so two sessions appending at the same instant cannot lose one to a
read-modify-write race.

The migration follows the existing `ALTER TABLE ... ADD COLUMN` ladder in
`store.init()` (`fork_from`, `goal`, `ctx_tokens` all landed this way),
with a comment naming what the column holds.

New store functions, all thin: `create_task(title)`, `get_task(id)`,
`task_members(id)`, `join_task(session_id, task_id)`, `add_note(task_id, note)`,
`spend_poke(task_id) -> bool` (atomic increment, False when the budget is gone).

## 2. `bridge/tasks.py` (new)

The task's rules, with no HTTP and no MCP in it, so it is testable directly —
the split `goals.py` / `goal_mcp.py` already uses.

- `resolve_project(name) -> str | list[str]` — matches `name` against
  `browser.list_projects()`: exact rel match, then exact basename, then
  case-insensitive substring. One hit returns the rel path; several return the
  candidates so the caller can ask rather than guess; none returns an empty list.
  Guessing here starts a session in the wrong repo, which is the one failure that
  costs real money and confusion.
- `delegate(chat_id, from_session, project, title, prompt) -> dict` — resolve,
  create-or-reuse the task on `from_session`, create the session in `project`,
  join it to the task, return `{task, session, project}`. Does not start the run
  (see §3 — that has to happen in the bridge process).
- `status(session_id) -> dict` — the task, its members with project/run state
  (`state.is_running`), and the notes.
- `note(session_id, text)` — append, tagged with the writing session.
- `siblings(session_id) -> list[dict]` — members minus self. Used by §4.

MAX_POKES = 6 lives here next to the code that spends it, mirroring
`goals.MAX_ITER`.

## 3. `bridge/task_mcp.py` (new) — the tools

A stdio JSON-RPC server shipped into every session next to `goals` and `verify`
(`runner._mcp_config`, two lines). It resolves its own session the way
`goal_mcp.py` does: `MYSTICAL_CLAUDE_SESSION_ID` → `get_by_claude_session_id`.

| Tool | Arguments | Does |
|---|---|---|
| `Delegate` | `project`, `task`, `prompt` | Starts a linked session in another repo |
| `TaskStatus` | — | The shared task: members, run state, notes |
| `TaskNote` | `text` | Appends a note the other sessions will read |

`Delegate`'s description is where the automatic behaviour actually lives, so it
is written as a trigger, not a capability: *"Call this the moment you realise a
change here requires a change in another repo on this machine — do not ask the
user to open that project themselves."*

Ambiguity is returned, not resolved: `resolve_project` giving three candidates
comes back as "Three projects match 'app': /apex, /apex-web, /apps/site — call
Delegate again with one of them", and nothing is created.

**Starting the run.** MCP servers are separate processes; run slots, the job
registry, the Telegram notifier and the queue all live in the bridge process.
`Delegate` therefore POSTs one dedicated endpoint, `/local/tasks/delegate`, with
`X-Dash-Token` — the same callback shape the `Run` tool uses
(`verify_mcp.py:263`), but with the whole operation on the far side: resolve,
create the session, join the task, start the turn, announce it. The tool passes
only `{from_session, project, task, prompt}` and relays the reply.

Everything ends up on the side that can already do it, and the endpoint is
directly testable without a subprocess. `TaskStatus` and `TaskNote` need none of
this and talk to the store directly, as `goal_mcp.py` does. No dashboard, no
delegation: the tool says so and creates nothing, rather than half-creating a
session that will never run.

The handoff prompt is composed by the caller (the model in session A) and
prefixed by the tool with the shared context the other side cannot see:

```
[shared task: <title>]
Started from <project A>, session <id>. Call TaskStatus() to see the other
side's progress, and TaskNote(...) when you learn something it needs.

<prompt>
```

## 4. Liveness: the poke, and its brake

`tailstate.py:162` is the one place a streaming turn's end is announced
(`runner.notify_turn_done`). Next to it, for a session with a `task_id`:
enqueue on every sibling a one-line nudge through `queue_manager.enqueue` —

```
[task] /apex finished its turn. <last note, if any> — call TaskStatus() before continuing.
```

Going through the queue rather than `start_streaming_job` is deliberate: a
sibling that is mid-turn must not be interrupted, and the queue already handles
"run it when the session frees up", plus pause, reorder and retry. The same
argument `goals.py` makes for putting its nudge on the queue.

**The brake.** Two sessions that poke each other on every turn end never stop:
A's poke ends a turn in B, which pokes A, which ends a turn in A. `spend_poke`
gives the whole task a budget of 6. Exhausted, no more nudges are enqueued —
the task stays fully readable through `TaskStatus`, the sessions stay usable,
they just stop waking each other. This is the same shape as `goals.MAX_ITER`
and for the same reason: an unattended loop spends a 5-hour window.

Two further guards, both cheap: a poke is never enqueued into the session that
just finished, and a task with one member enqueues nothing at all.

## 5. Notification

One line per delegation on the existing `_notify` path in `runner.py`, so it
reaches Telegram and the panel with no new transport:

```
⇄ /apex — <task title> — linked session started
```

Turn-done pings for the delegated session are what they already are; the ⇄ line
is only for the moment a session appears in a repo you didn't open yourself.

## 6. Surfaces

In the order `bridge-feature-slice` prescribes:

1. `store` — above.
2. `bridge/miniapp/server.py` — `_session_brief` gains
   `task: {id, title, members: [{id, project}]} | null`. It is *shared*: the
   dashboard imports it (`server.py:40`), so one edit feeds both surfaces' rows.
   The extra query runs only for a row that has a `task_id`.
   `bridge/dashboard/server.py` adds `GET /local/tasks/<id>` (the task with its
   notes) and `POST /local/tasks/delegate` (§3).
3. Dashboard `SessionsPanel` — a `⇄` chip on a linked row showing the sibling's
   project; tapping it filters the list to the task's members. The chip reuses
   the branch/attention chip styling already on the row (Sessions Panel v3), so
   this is one more chip, not a new row layout.
4. Mini App session list — the same chip, no filter (the list is short).
5. Bot — nothing beyond §5's `⇄` line. There is no bot-side session list to
   mark: the Panel and the Mini App are that surface.

No TASKS tab. The task is a property of the sessions, and a tab implies a
backlog nobody asked to manage.

## 7. Testing (`tests/test_tasks.py`)

Against the pinned test DB (`tests/conftest.py`), no Claude:

- `delegate` creates a session in the named project, joined to the same task as
  the caller, and the caller is joined too.
- An ambiguous project name creates no session and no task, and names the
  candidates. An unknown name creates nothing.
- Two `add_note` calls from different sessions both survive (concurrent
  read-modify-write); notes cap at 50.
- The poke budget stops nudges at `MAX_POKES`; a single-member task enqueues
  none; a session is never poked by its own turn ending.
- `resolve_project` prefers exact rel over basename over substring.

The `Delegate` HTTP callback is tested against a stub dashboard handler, the way
the existing Run-tool tests do, so no bridge process is needed.

## What this does not build

A TASKS tab or any task browser; task archival and history; tasks spanning more
than the two sessions that a `Delegate` creates (the schema allows N members and
nothing schedules them); cross-machine tasks; automatic detection without a tool
call. Each is a separate ask, and none is load-bearing for the case that started
this: one change, two repos, no re-typing.
