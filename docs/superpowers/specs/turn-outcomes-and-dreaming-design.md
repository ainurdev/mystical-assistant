# Turn outcomes, and the nightly pass that learns from them

Two features, built in that order, because the second one reads the first.

**Outcomes** names why a turn ended the way it did. No model call, no new column,
no migration: it is a pure function of the turn row and the events already in the
store, so it answers for every turn ever recorded, not just new ones.

**Dreaming** is the scheduled pass the industry converged on in 2026 — review
finished sessions, keep what generalises, and carry it into the next run. Here it
reads the lessons `learn.py` already writes plus the outcomes above, and writes
one small per-repo digest that rides the once-per-session prompt pack beside the
graph map and the task digest.

Outcomes spends nothing, so it has no switch. Dreaming spends a call a night and
injects tokens into every session, so it registers in `bridge/aifeatures.py` like
every other extra and its UI leaves the dashboard when it is off.

## What already exists (verified)

Measured read-only against `~/.bridge_state/bridge.db` on 2026-09-12 (2,662
turns):

- **`turns.status` is only ever `running` / `done` / `error`** (2,274 done, 384
  error, 4 stranded running). There is no reason column and no place for one to
  be written from — `store.finish_turn(turn_id, status, cost, elapsed)` is the
  whole write path.
- **Of the 384 error turns, only 109 carry an `error` event.** Its payload is
  `{"type": "error", "message": "claude exited -9"}` — that and
  "`claude` not found on PATH" are the common messages.
- **275 error turns record no reason at all.** Split cleanly in two:
  - **136 did real work first** — they have `text` events, cost and elapsed
    (up to $15 and 37 minutes), then a `result` event whose `result` string is
    empty. The user did get an answer in the transcript; the row says failure.
  - **139 died instantly** — no `text`, cost 0, elapsed 0. Nothing was said.
- **`log` events are hook output, not stderr.** 1,812 of 1,825 are
  `{"src": "hook", "label": …, "text": …, "error": false}`; only 13 are
  `src: "stderr"`. So stderr is not a reliable reason source, and a classifier
  that leans on it explains almost nothing.
- **The classifiers already exist.** `bridge/limits.py` exposes
  `is_limit_error`, `is_server_error`, `is_context_error`, `is_auth_error` over
  free text. Outcomes dispatches to those rather than growing its own regexes.
- **The prompt pack has two sources and room for a third.**
  `runner._base_cmd` joins `_graph_pack_for()` and `_tasks_digest_for()` once per
  session (`_packed_sessions` gate) into `_compose_system_prompt(graph)`. The
  graph pack costs ~400 tokens, the task digest ~300.
- **`learn.py` writes one lesson per turn** into that repo's `.mystical/learn/`,
  numbered, each tagged `> concept:`, and `all_lessons()` already gathers every
  repo's. Nothing reads them back into a run — that is the gap dreaming fills.
- **`report.py` has the scheduling posture to copy**: due-ness is a pure
  function of `(now, last-sent marker)` checked at boot plus one re-armed
  `threading.Timer`, so a laptop that was asleep at the appointed hour still
  fires. `limits.py` does the same.
- **`aifeatures.py`** is a tuple of dicts (`key`, `env`, `label`, `hint`, `cost`,
  `tokens`, `about`) + `enabled(key)`; the setting persists to
  `ai_features.json` beside the DB, falls back to a `config.*` env setting, then
  to off. Each feature's own UI is hidden while its switch is off.

## Phase 1 — outcomes

`bridge/outcomes.py`, read-side only. One function:

```python
def outcome(turn: dict, events: list[dict]) -> dict | None
```

`None` for a healthy `done` turn — a green turn needs no label. Otherwise
`{"code": …, "label": …, "detail": …}` with the code decided in this order, first
match winning:

| code | test | label |
|------|------|-------|
| `restarted` | error message matches `exited -9` | the bridge restarted mid-turn |
| `auth` | `limits.is_auth_error` or `not found on PATH` | Claude could not start |
| `limit` | `limits.is_limit_error` | usage limit |
| `overloaded` | `limits.is_server_error` | the API was overloaded |
| `context` | `limits.is_context_error` | the context ran out |
| `timeout` | `elapsed >= config.RUN_TIMEOUT` | hit the 30-minute cap |
| `empty` | has `text` events, `result` event's `result` is blank | it worked, then returned nothing |
| `silent` | no `text`, no cost, no elapsed | died before it said anything |
| `stopped` | status `error` with a `stopped` event | you stopped it |

`empty` and `silent` are the 275-turn class the store cannot currently explain,
and they are the two worth telling apart: `empty` means *read the transcript, the
work is there*; `silent` means *nothing happened, re-send it*.

Wiring, per the bridge-feature-slice order:

1. `bridge/outcomes.py` — the function above. Stdlib only. No storage row.
2. Dashboard `GET /local/outcomes?session=<id>` → `{turn_id: outcome}` for a
   session, and a `since`-windowed variant for the report.
3. Mini App `GET /api/outcomes?session=<id>` — the same function, same shape.
4. `api.ts` / `miniapp/web/src/lib/api.ts` — typed, tolerating a 404 from an
   older bridge process the way `SpendPanel` does.
5. Both turn rows render the label on a failed turn, in place of the blank.
6. `report.py` gains one section: last week's failures grouped by code.
7. `tests/test_outcomes.py` (the taxonomy, fixture events) and
   `tests/test_outcomes_endpoint.py` (both routes).

Skipped deliberately: no bot command (the label belongs on the turn, and the
Telegram ping already says why when there is an error event), no pubsub (a
finished turn's outcome cannot change), no settings switch (zero tokens).

## Phase 2 — dreaming

`bridge/dream.py`, registered in `aifeatures.FEATURES` as `dream`
(`env: "DREAM_ENABLE"`, ships OFF — it runs on its own with nobody pressing
anything).

Nightly, on `report.py`'s due-ness posture: for each repo with sessions that
finished since the last pass, one cheap read-only `claude -p` gets that repo's
new lessons plus its failed turns' outcome codes, and returns at most ten lines
of durable, repo-shaped guidance — what this codebase keeps teaching, and what
keeps going wrong. It replaces, rather than appends to, `.mystical/dream.md`, so
the digest cannot grow without bound.

That file becomes the third prompt-pack source in `runner._base_cmd`, behind the
same once-per-session gate, capped at the graph pack's ~400 tokens.

Open question for the user, not decided here: whether the pass **writes the
digest itself** or **proposes it on an approve card** the way permission prompts
already work. Auto-write is the trend's actual claim (agents improve between
runs, unattended); a card keeps a bad night from poisoning every session until
someone notices.

Skipped deliberately: no touching `~/.claude/projects/*/memory/` — that is
Claude Code's own auto-memory store, and two writers on one file is how drift
starts. No new DB table; one markdown file per repo, git-ignored like `dev.log`.
