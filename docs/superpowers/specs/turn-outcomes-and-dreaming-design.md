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
- **275 error turns record no reason at all.** Split by what their events do
  and do not contain:
  - **147 carry a non-blank `result`** — but 130 of those results *are* the
    error ("API Error: Server is temporarily limiting requests", an expired
    login). Only 17 are a real answer on a row that says failure.
  - **57 carry a blank `result`** after the agent had been talking.
  - **52 carry no `result` and no message** — the signature of
    `claim_orphaned_turns`, which flips a restart's abandoned turns at boot.
  - **19 carry a blank result and never spoke.**
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

The message is read first, from an `error` event or — the trap — from a result
string that is itself an error. `elapsed` is never a test: RUN_TIMEOUT is a
*silence* watchdog, so a healthy turn can run for an hour, and a hang kill says
so in its own message.

| code | test | count |
|------|------|-------|
| `timeout` | message says "killed as hung" or "Timed out after" | 45 |
| `restarted` | message says `exited -9` | 12 |
| `auth` | `limits.is_auth_error` or `not found on PATH` | 10 |
| `limit` | `limits.is_limit_error` | 43 |
| `overloaded` | `limits.is_server_error` | 75 |
| `context` | `limits.is_context_error` | 3 |
| `crashed` | any other message | 51 |
| `stopped` | a `stopped` event | – |
| `interrupted` | no `result` event and no message | 52 |
| `delivered` | a `result` that is not itself an error | 17 |
| `empty` | blank `result`, but the agent had been talking | 57 |
| `silent` | blank `result`, never spoke, nothing spent | 7 |
| `failed` | anything left | 12 |

The three worth telling apart are `delivered` (*read it, nothing to re-send*),
`interrupted` (*a restart, recovery has it*) and `empty` (*partial work, re-send
if it never got to the point*). Collapsing them into "failed" is what made the
old blank row useless.

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

Decided 2026-09-12: the pass **writes the digest itself**, unattended — the
trend's actual claim, and the version that works while you are away from the
keyboard. The guards that replace the approve card are all in the writing: a
model that declines (no bullets) leaves the previous digest in place, the digest
replaces rather than grows, it is capped at ten lines / ~400 tokens, and the
whole thing is one switch away from gone.

Skipped deliberately: no touching `~/.claude/projects/*/memory/` — that is
Claude Code's own auto-memory store, and two writers on one file is how drift
starts. No new DB table; one markdown file per repo, git-ignored like `dev.log`.


## Built

Both phases shipped 2026-09-12: outcomes in `c2a3b1ce` + `996cf693`, dreaming in
`e82ee4c4`. Two departures from the plan above, both because the code was
already there:

- **No new endpoints.** The outcome rides `store.transcript()`, which both
  servers already call, so neither client needed a route, a client method or the
  404 tolerance `SpendPanel` has. Rows 2–4 of the feature slice were skipped.
- **No panel for the digest.** It is written into `.mystical/docs/`, which
  `docs.py` already walks, so the DOCS tab reads it for nothing. `docs.py` hides
  it while the switch is off, which is the whole of "its UI goes with it".

Neither is live until the bridge restarts.
