# Context meter + autocompact

A session dies of "prompt is too long" without warning. The bridge already
receives the number that predicts it and throws it away. This surfaces that
number, and exposes the CLI knob that acts on it.

## The measure

Context size is the **last** assistant message's

```
input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

Measured on a real transcript: `2 + 75773 + 1623 = 77398` tokens — the size of
the request that was just sent, i.e. how full the window is right now.

This is not the same number as `transcript_jsonl.py:369`, which `+=` those
fields across every assistant message in a turn. That sum is *spend* (what the
turn cost) and runs an order of magnitude high as a window measure. The meter
must read the last message, never accumulate.

Cache split (`cache_read` vs `cache_creation`) is deliberately not shown — it
answers a cost question, not "am I about to die".

## Where it comes from

`runner._handle_event`, the `assistant` branch (`runner.py:1084`), already sees
every assistant message on every streaming surface and ignores `message.usage`.
One computation there covers Mini App, dashboard and bot turns.

- **Live**: publish `{"type": "ctx", "tokens": N}` on each assistant event.
  Free — the event stream is already being written to.
- **Cold**: persist to `sessions.ctx_tokens` on the `result` event, once per
  turn rather than once per message. A session list load then shows a number
  without re-parsing any JSONL, because it rides the session payload the
  frontends already fetch.

Sessions whose last turn predates this feature show no meter until their next
turn. Accepted: no backfill, no JSONL scan.

## Denominator

`config.CONTEXT_WINDOW`, default `200000`, env-overridable. The bridge cannot
know a given model's real window (the Models API doesn't report it), and
1M-context runs are the exception; an env var is the whole escape hatch.

## The control

`claude --autocompact <auto|100k–1M>` already exists and `_base_cmd` never
passes it. Lower threshold = compacts sooner.

- `sessions.autocompact TEXT`, null = don't pass the flag (CLI default `auto`).
- Server-side validation mirroring `MINIAPP_PERMISSION_MODES`: `auto`, or a
  token count in 100k–1M. Anything else is rejected, not coerced.
- Passed in `_base_cmd` alongside `--model`/`--effort`. Skipped for internal
  one-shots (`skip_pack`) — a titler call is one turn and never near the window.

No custom summarisation, no manual "compact now". The platform does the
compaction; this only chooses when.

## UI

- Mini App: one more segment in `UsageStrip.tsx:17` — `5h 31% · Wk 52% · ctx 39%`.
  Amber past 75%, red past 90%, matching `sevColor`'s existing thresholds.
- Dashboard: a pill in `StatusBar.tsx` next to the per-account usage pills.
- The autocompact picker sits wherever the session's permission mode is chosen,
  as a peer of the other per-session postures.

## Verification

`tests/test_context_meter.py`:

1. A fake `assistant` event with a known `usage` dict → the published `ctx`
   event carries the sum of the three fields, and two events in a row report
   the second message's value rather than their total.
2. `_base_cmd(..., autocompact="150k")` puts `--autocompact 150k` in argv;
   with `None` the flag is absent; with `skip_pack=True` it is absent.
3. An invalid value is rejected by the endpoint validator.

## Skipped

- Cache-hit-rate display — cost question, not a survival question.
- Per-model window detection — env override instead.
- Backfill for pre-existing sessions — fills in on next turn.
- Manual compact-now — would need `/compact` over the stream-json input
  channel, which is unverified. Add if the threshold knob proves too blunt.
