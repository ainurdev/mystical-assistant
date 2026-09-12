# Session time + token attribution — where a session's hours actually went

**Date:** 2026-08-13
**Scope:** `bridge/attribution.py` (new); `bridge/runner.py`, `bridge/store.py`,
`bridge/transcript_jsonl.py`, `bridge/dashboard/server.py`; dashboard + Mini App
session panel, run stream footer, History/Chats rows.

## Problem

A session can run for hours and leave nobody able to say what consumed them.

The case that prompted this: `A.1 AMS Import Review Fixes` ran fourteen turns, **ten
of which died at the 1800s `RUN_TIMEOUT` cap** (`bridge/config.py:64`) and auto-resumed.
From the dashboard this reads as a session that is simply slow. Answering "why" took a
hand-written script against the SQLite store. The answer, once extracted:

| Tool | Calls | Union time |
|---|---|---|
| Agent | 26 | 243.9 min |
| Bash | 1664 | 34.5 min |
| AskUserQuestion | 1 | 31.6 min |
| TaskOutput | 5 | 13.1 min |
| Read / Edit | 283 | ~0.1 min each |

Twenty-six subagents, averaging 9.4 minutes, run strictly one after another. That is
the whole story of the session, and it was already sitting in the `events` table.

Dollars are not the missing number. `9f612a4` removed all five dollar readouts because
the CLI reports `total_cost_usd` off API list prices while these runs go through a
subscription — a number with no bill behind it. What is missing is **time, attributed**,
and **tokens, which are real**.

## Goal

Answer "what did this session spend, and on what" from data the bridge already writes,
on four surfaces: a session detail panel, the turn footer, History/Chats rollups, and
live while a turn is still running.

## Non-goals

- **Dollar costs.** Deliberately removed in `9f612a4`; this does not bring them back.
  `_cost_from_usage` (`bridge/transcript_jsonl.py:87`) stops being the destination for
  token counts, though it stays for any caller that still wants an estimate.
- **New instrumentation on the hot path.** Every timing input already exists. If a
  breakdown needs a number nobody records, the breakdown does without it.
- **Backfilling tokens for bridge-run sessions.** They were never stored and cannot be
  recovered. Time backfills for free; tokens start at deploy.
- **Cross-session or per-project spend reporting.** One session at a time. The History
  rollup shows per-session totals, not aggregates over a repo or a week.

## What already exists

This is most of the feature, which is why the approach is a query rather than a pipeline.

**Per-tool durations are already written.** `store.append_event` (`bridge/store.py:688`)
persists every event with a `ts`, and the payloads carry what is needed:

| type | payload keys |
|---|---|
| `tool` | `type`, `name`, `id`, `summary` |
| `tool_done` | `type`, `id`, `ms`, `output`, `is_error` |
| `thinking` | `type`, `ms` |
| `result` | `type`, `result`, `cost`, `elapsed`, `is_error` |

`tool_done.ms` is the duration; the row's `ts` is the end. Joining `tool` → `tool_done`
on `id` gives every call a name, a duration, and an end timestamp.

**Token counts already flow past two places and are discarded in both.**
`runner._ctx_of` receives the full `usage` dict on every assistant message and keeps
only `input + cache_read + cache_creation` as a window-fill gauge, dropping
`output_tokens` and the per-turn totals. `bridge/transcript_jsonl.py:482-489` already
accumulates all four counters per turn for adopted native sessions, then spends them on
a dollar estimate at line 533.

**A dead aggregate is already in the History query.** `store.history()`
(`bridge/store.py:814-823`) still computes `COALESCE(SUM(t.cost), 0) AS total_cost` for
a UI that stopped rendering it in `9f612a4`.

## Design

### Capture: keep what is already in hand

Three edits to existing write paths. None adds a call, a request, or a hot-path cost.

1. **`bridge/store.py`** — four nullable columns on `turns`: `tok_in`, `tok_out`,
   `tok_cache_w`, `tok_cache_r`. Added with the existing ALTER-if-missing migration
   pattern used for `ctx_tokens` (`bridge/store.py:153`).
2. **`bridge/runner.py`** — where `_ctx_of` already reads `usage`, also accumulate the
   four counters onto the job, and persist them at turn end alongside `ctx_tokens`
   (`bridge/runner.py:1181` accumulates, `:1481` persists). Note the distinction the
   `_ctx_of` docstring already draws: the *last* message's figure is window fill; the
   *sum* across a turn is spend. This stores the sum, which is what spend means.
3. **`bridge/transcript_jsonl.py`** — return the `_usage` accumulator on the turn dict
   so adopted native sessions populate the same four columns, instead of only folding
   it into `cost`.

### Computation: `bridge/attribution.py`

One new read-side module. No writes, no model calls, best-effort throughout — the
posture of `graphmap` and `memory`: a failure yields an empty breakdown and never
blocks a turn.

`breakdown(session_id) -> dict` returns:

- **`wall`** — `SUM(turns.elapsed)` across the session.
- **`tools`** — per tool name: `calls`, `union_s`, `naive_s`, `avg_s`, `unfinished`.
  `AskUserQuestion` is **excluded** from this map; it is reported only as `waiting_s`,
  so it is never counted twice.
- **`thinking_s`** — summed `thinking.ms`.
- **`waiting_s`** — the `AskUserQuestion` union. A session that waited 31.6 minutes on a
  human was not slow, so this is its own line and never sits inside tool time.
- **`model_s`** — the remainder: `wall` minus **one union taken across every interval at
  once** — tool calls, thinking, and waiting merged into a single merge pass, not three
  unions added together. Adding them would re-introduce the double-counting the union is
  there to remove, since a `thinking` span can overlap a tool span. What is left is
  generation.
- **`tokens`** — the four counters summed over turns, `None` where unrecorded.
- **`capped`** — turns with `status == 'error'` **and** `elapsed >= RUN_TIMEOUT`. Both
  conditions are required: elapsed alone is not sufficient, because a turn can legitimately
  exceed the cap after an internal resume (the motivating session's turn 13 finished
  `done` at 3126s). Ten turns qualify there; a breakdown that omits this hides the main
  event.

**Interval union, not naive sums.** Parallel tool blocks overlap, so adding durations
double-counts wall clock — measured at 18.4 min across the motivating session (6%), with
202 of 2019 calls overlapping a sibling. Since `tool_done` gives an end (`ts`) and a
duration (`ms`), `start = ts - ms/1000` reconstructs real intervals, and merging them
per tool name gives a share that sums to at most 100% of wall clock. `thinking` events
carry the same two fields and reconstruct the same way, so they join the same merge.

Both figures are kept, because their **difference is itself the finding**: when
`naive == union` a tool never ran concurrently with itself. That is how 26 strictly
serial subagents became visible, and it is the number that says whether parallelising
them is available as a fix.

### Delivery

`GET /local/session/breakdown?session=<id>` in `bridge/dashboard/server.py`, beside the
existing `/local/graph/*` handlers. One endpoint, four consumers:

- **Session detail panel** (dashboard + Mini App) — the full ranked breakdown.
- **Turn footer** — tokens beside the elapsed already rendered in both `RunStream.tsx`
  (`FinalResult`, the component `9f612a4` removed the dollar figure from).
- **History / Chats rows** — `store.history()` swaps the dead `SUM(t.cost)` for
  `SUM(t.elapsed)` and the token sums, restoring the slot the dollar figure vacated.
- **Live during a run** — the panel polls the same endpoint. In-flight turns already
  have their events in the store, so a 30-minute turn can say what it is stuck on before
  it hits the cap. No change to the streaming path.

Both frontends get the same treatment: `9f612a4` touched dashboard and Mini App
together, and parity is the existing convention.

### Error handling

- Missing or malformed `ms` — that call contributes 0, never raises.
- A `tool` with no matching `tool_done` — the turn was killed mid-call. Counted as
  `unfinished` and reported, not silently dropped. The motivating session has ten
  capped turns and would otherwise under-report.
- Tokens null on pre-deploy turns — rendered as `—`, never `0`. An old session must not
  read as free.
- Union of an empty interval set is 0; a session with no events returns a zeroed
  breakdown rather than an error.
- `model_s` can compute negative if attribution overshoots `wall` (nested or clock-skewed
  intervals). Clamp at 0 and expose the overshoot rather than displaying a negative.

### Testing

`tests/test_attribution.py`:

- Union math over overlapping intervals; the disjoint case where `naive == union`.
- Orphan `tool` events with no `tool_done` → counted as `unfinished`.
- A session with no events → zeroed breakdown, no exception.
- Tokens `None` vs `0` preserved distinctly through the query and the API.
- `model_s` clamped at 0 when tool union exceeds `wall`.
- `capped` detection against turns in `error` status at the cap boundary.

## Open question

Adopted native sessions *could* have historical tokens backfilled, since
`transcript_jsonl` already parses their JSONL. Left out of scope: it is a one-off
migration serving a minority of sessions, and it can be added later without changing
any interface described here.
