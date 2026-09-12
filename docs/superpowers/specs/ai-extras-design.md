# Smart pings, away digest, and a settings tab that shows what it costs

**Date:** 2026-08-03
**Scope:** `bridge/pings.py`, `bridge/digest.py` (new); `bridge/aifeatures.py`,
`bridge/runner.py`, `bridge/dispatch.py`, `bridge/config.py`,
`bridge/dashboard/server.py`; dashboard `SettingsModal`/`api.ts`;
`tests/test_pings.py`, `tests/test_digest.py`, `tests/test_aifeatures_spend.py` (new).

## Problem

Three complaints about the same tab.

**Every finished turn pings you.** `runner.notify_turn_done` fires a ✅ or ⚠️ for
every non-interrupted turn, whether Claude asked you something, hit a wall, or
quietly reformatted an import. On a phone that trains you to ignore the pings you
actually needed.

**Coming back is manual.** Nine turns ran while you were out. Reading them means
opening nine sessions and skimming nine transcripts to reconstruct one sentence:
what happened, what broke.

**The AI tab prices itself in guesses.** Every switch carries a static string —
"1 haiku call per new session" — written when the feature was designed. Nothing
records what any of them actually spent, so deciding whether an extra earns its
keep is unanswerable from the panel that offers the switch.

## Goal

Two new registry entries, and a panel that reports instead of estimates:

- **`notify`** — a finished turn pings you only when it wants you, and arrives with
  two or three tap-to-send next prompts.
- **`digest`** — one paragraph covering every turn that finished since you last
  looked, on demand.
- **Panel** — real spend per feature, the model picker for the two features that
  already read a model, and one switch that turns everything off.

## Non-goals

- **Filtering anything but turn-done.** Approval prompts, usage-limit parks and
  API-retry notices go out unchanged, always. See *The hook*.
- **Scheduled digests.** A cron pings you at 4am. The digest is pulled, never pushed.
- **A spend cap.** Capping means picking a threshold you cannot predict; the counter
  exists so you can decide with numbers, and the switch is already there.
- **Rewriting a follow-up.** The chips send their text verbatim as the next prompt.
- **New model knobs.** Only `RELEVANCE_MODEL` and `NEXTUP_MODEL` exist; only those
  two get a picker.

## Part 1 · `notify` — smart pings and follow-up chips

### The hook

`runner.notify_turn_done` (`bridge/runner.py:746`), and nothing else.

Gating the shared `_notify` (`:720`) instead would be the smaller diff and the wrong
one: every other caller is a message you must not lose. `notify_awaiting` fires when
a run is *blocked on you*; the limit-park and server-retry notices report that a
session stopped or is being retried. Those are state changes, they are already rare,
and a classifier that suppresses one costs you a session sitting dead. Turn-done is
the only noisy ping, and every turn-done routes through this one function.

### Plumbing

One argument. The single call site (`runner.py:1205`) already sits two lines below
`"\n\n".join(job.texts)`, which `_capture_async` uses for memory capture — the same
text the classifier needs.

```python
notify_turn_done(job.chat_id, job.store_session_id, job.status == "error",
                 text="\n\n".join(job.texts))
```

`text` defaults to `""`. With the feature off, or with no text, behaviour is today's,
line for line.

### `bridge/pings.py`

Built on `bridge/relevance.py`, which is the same shape: one cheap one-shot, JSON out,
fail open. It shares that module's four conventions — `native.INTERNAL_ONESHOT_TAG` so
the run never surfaces as a phantom session, `skip_pack=True`, a tolerant `_parse`
that reads a bare `{...}` out of surrounding prose, and a failure path that returns the
permissive answer.

```python
classify(chat_id, session_id, text, is_error) -> {
    "push": bool,             # does this want the human?
    "why": str,               # one short sentence, unused in v1 UI
    "followups": [str, ...],  # 0-3 next prompts, each <= 120 chars
}
```

The prompt classifies the turn as DATA, never as instructions — same defence as
`relevance._SYS`, and it matters more here because the classified text is Claude's own
output. Push when the turn asked a question, stopped short, failed, or finished
something worth knowing. Stay silent for routine completions.

**Fail open.** Disabled, timed out, non-zero exit, unparseable reply → `push: True`
with no follow-ups. A missed ping is worse than a redundant one, so every failure
path lands on today's behaviour.

**An error turn always pushes** without a call. `is_error` is already the answer;
paying a model to confirm it is spend for nothing.

### Follow-up chips

Rendered as an inline keyboard on the ping, mirroring the next-up board
(`dispatch.py:87`).

Telegram caps `callback_data` at 64 bytes, so the prompt cannot travel in the button —
the next-up board solves this by sending an id and resolving it server-side, and the
chips do the same: `fu:<turn_id>:<n>`, with the suggestions held in a process-local
dict keyed by turn id, capped at the most recent 200 turns.

Tapping one dispatches its text as the next prompt in that session, through the same
path as `nx:`. A tap after a bridge restart, or after the cap has evicted the entry,
answers `⌛ that suggestion expired` and does nothing else.

Suppressed turn → no push, so no chips. That is the intended trade: a turn not worth
telling you about is not worth suggesting three follow-ups for.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `PINGS_ENABLE` | off | env fallback, per the registry's precedence |
| `PINGS_MODEL` | `haiku` | model for the classifier |
| `PINGS_TIMEOUT` | 45 | seconds before falling open to a push |

Registry entry: `{"key": "notify", "env": "PINGS_ENABLE", "label": "SMART PINGS",
"hint": "pings you only when a turn wants you, with tap-to-send follow-ups",
"cost": "1 haiku call per finished turn"}`.

## Part 2 · `digest` — away catch-up

### Trigger

Pulled, never pushed. `GET /local/digest` — the dashboard asks once on open, and
`/digest` asks from Telegram. No client-side "has it been long enough" threshold: the
marker is the only judge, and an empty window answers empty.

Nothing finished since the last digest → an empty payload and **no model call**. The
common case, opening the dashboard twice in a minute, costs nothing.

### Window

Turns whose *finish* time is at or after the marker:

```sql
SELECT ... FROM turns
 WHERE status IN ('done','error')
   AND started + COALESCE(elapsed,0)/1000.0 >= ?
```

`turns` records `started` and `elapsed`, not a finish time (`store.py:39`). Filtering
on `started` alone would drop a long turn that began before the marker and finished
after it — precisely the turn you were away for. Computing finish time in the
predicate costs one expression and no schema change.

Capped at the 40 most recent turns. The marker is the digest's own timestamp, in a
small JSON beside the DB, the same pattern and directory as `ai_features.json`.

### What it reads

Per turn: session title, project, prompt (trimmed), status, elapsed. Not the assistant
text — that lives in `events` and would need transcript assembly per turn.

```python
# ponytail: prompts + status only; if the summaries read thin, pull the last
# assistant text per turn out of events and feed that too.
```

One `run_blocking` call over the batch (not per turn) returns a short paragraph plus a
`sessions` list of `{id, title, line}` so the dashboard can link each one. Failure or
unparseable reply → a plain mechanical list of the same turns, no summary. The digest
degrades to what it could have shown without a model rather than to nothing.

The marker advances only on a delivered digest. A failed call leaves the window intact
for the next pull.

Registry entry: `{"key": "digest", "env": "DIGEST_ENABLE", "label": "AWAY DIGEST",
"hint": "one paragraph on everything that finished while you were gone",
"cost": "1 haiku call per catch-up"}`.

## Part 3 · Panel

### Real spend

`bridge/usage.py` reads the account-level OAuth limits endpoint; there is no
per-feature ledger anywhere. Add one to the module that already owns the state:

```python
aifeatures.record(key, cost)   # bumps {"calls": n, "spent": float, "week": iso}
```

Counters live in `ai_features.json` beside the switches, roll over weekly on read, and
never raise — a failed write loses a counter, not a turn. Five existing call sites gain
one line each; every one already receives `cost` back from `run_blocking`.

`state()` returns `spend` per feature. The panel renders `$0.14 · 37 calls this week`
under the switch, falling back to today's static `cost:` string for a feature that has
never run.

### Model picker

`RELEVANCE_MODEL` (`config.py:136`) and `NEXTUP_MODEL` (`:152`) exist and are reachable
only by whoever set the environment. A feature whose registry entry names a `model_env`
renders a haiku/fable select; the rest render nothing. `notify` and `digest` ship with
one, so four of seven have a picker.

Persisted next to the switches, same precedence: saved value, then env, then default.

### ALL OFF

One control that clears every persisted key back to off. No new endpoint — it is the
existing `POST /local/aifeatures` per key.

## Failure

| Path | Answer |
|---|---|
| classifier times out / errors / returns junk | push, no chips (today's behaviour) |
| turn errored | push, no call |
| chip tapped after restart or eviction | `⌛ that suggestion expired` |
| digest call fails | mechanical turn list, marker not advanced |
| nothing new since last digest | empty payload, no call |
| counter write fails | in-memory count stands, no error surfaces |
| bridge running an older build | panel already handles this (`SettingsModal.tsx:858`) |

## Cost

Nothing changes until a switch is on — every entry is off by default, as the registry
requires (`aifeatures.py:5`).

- `notify`: one haiku call per finished turn. The most expensive of the seven, because
  it is the only one that fires on every turn regardless of content.
- `digest`: one haiku call per catch-up with new turns, zero otherwise.
- Panel: no calls.

## Testing

Matching `tests/test_relevance.py`'s approach — inject the runner, never spawn a CLI.

`tests/test_pings.py`
- off → `notify_turn_done` pushes exactly as before, and makes no call
- on, push verdict → one push, keyboard carries N chips
- on, silent verdict → no push, and the turn is still in the dashboard
- error turn → pushes without calling the classifier
- timeout / non-zero exit / junk / bare `{...}` in prose → pushes (fail open)
- `notify_awaiting` and the limit-park notice are never filtered, feature on or off
- chip tap resolves to the right prompt; unknown id answers "expired"
- eviction past 200 turns drops the oldest entry

`tests/test_digest.py`
- empty window → no call
- a turn that started before the marker and finished after is included
- 41 turns → 40 read
- failed call → mechanical list, marker unchanged
- delivered digest advances the marker; the next pull is empty

`tests/test_aifeatures_spend.py`
- `record` accumulates calls and cost; `state()` reports them
- week rollover zeroes the counters
- unwritable path keeps the in-memory count and raises nothing
- an unknown key raises `ValueError`, as `set_enabled` does

## Implementation order

1. Panel (`record` + counters + `state`, picker, ALL OFF) — no new model calls, and it
   is the thing that tells you what the next two cost.
2. `digest` — self-contained, one endpoint, one command.
3. `notify` — touches the run loop, so it lands last and alone.
