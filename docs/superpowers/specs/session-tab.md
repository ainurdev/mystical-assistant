# SESSION tab: TURNS and FLOW in one, with where the tokens and the time went

Asked 2026-11-08 (/design-first): "mix flow and turn into one tab … how much token on what, turn and
flows, reimagine and rethink the UI UX". Three directions were drawn on real sessions; the user
picked **B · CURVE** (not the recommended A · CHAPTERS), asked for time beside the tokens, took all
four add-ons, and approved round 2 as drawn. Drafts: `.mystical/design-drafts/session-tab/`
(cards 01–04, SPEC.md). UX pattern: `session-tab`.

## The tab (components/hud/SessionPanel.tsx)

One right-rail tile, SESSION, where TURNS stood; FLOW's tile is gone. Top to bottom:

1. **Hero (132px): the window on the clock.** One step per request (lib/meter `stepLine`), the 150k
   smart zone dashed, compactions marked. Under it a strip of who was working at each moment: Claude
   (accent), tools (`--info`), helpers (`--purple`), waiting on you (ask hue), away (hatched). A wait
   on you, or away, over 30 minutes folds into a 20px break labelled with its length. Under the strip
   the path's steps as bands (a `/mattpocock-skills:x` turn opens x's step, `/compact` is a sliver),
   or one band per row with no path; while a step runs, the next is a dashed band. **Compact** shows
   once the window passes the zone; it goes through `send`, so behind a running turn it queues.
2. The now bar from TURNS (working / waits on you, with Answer).
3. **TIME**: total since the first turn, "worked" = Claude + tools + helpers, a stacked bar, five sums.
4. **ON WHAT**: a WINDOW / SPENT switch over rows per kind (top five, the rest folded into Other).
   Both lenses sit in one grid cell, so switching never resizes the box. A row opens its three
   biggest items; WINDOW by size now, SPENT by size × the requests that re-read it ("11K ×387").
   An item opens the turn it came in.
5. **HELPERS**: running first, then by spend; time and tokens each; a tap opens its run in AGENTS.
6. **TURNS**: one line per prompt (resumes folded, as TURNS did), skill commands shown as their
   name, moments as marks (each jumps to its place), time and spend. Click jumps; copy / send again
   on hover; find, ⌥↑/⌥↓ and the lit row that follows the chat are TURNS' own.
7. **NEXT**: the path's next step, who starts it, AUTO; who picked the path and why on hover.

Stored settings move over: a `rightTab`, `rightOrder` or `rightHidden` naming `turns` or `flow`
names `session` (lib/theme.ts), and an old `hud:rail` link to either opens SESSION.

## The numbers (bridge/meter.py, GET /local/sessions/<id>/meter)

Read from the CLI's own transcript, not the bridge's events: only the JSONL has every request's
usage. The module docstring has the rules; in short:

- Window per request = input + cache read + cache write. A message counts once, by id (the CLI
  writes one record per content block, each repeating its usage).
- What fills the window is worked out by difference between requests: the previous request's
  output is "Claude wrote" (exact), the rest is shared by the items that arrived in between, by
  text length (the one estimate). A compaction restarts it at start-up + summary.
- Spend by kind charges each request for the window it read plus its output, and adds the helpers'
  own transcripts, so the kinds add up to the total.
- Time from the main thread's open tool calls; an unanswered call ends with its own turn.
- Files are read from where the last read stopped; a cached read of a 26 MB session with 72 helpers
  takes about 10 ms.

## Fixed on the way: per-turn token counts

The stored `tok_*` per turn were wrong both ways (turn 1 of "Make Settings Modal Bigger": output
801 stored vs 52,855 real; cache reads 10.2M vs 4.52M). The stream repeats a message's usage on
every block, and that usage is the message's as it started. Checked against the real CLI on
2026-11-08: `result.usage` is exact and per query (a woken turn's second result covers only its own
request), main thread only; `modelUsage` is cumulative for the whole session and includes helpers.
So `runner._add_usage` counts a message once by id while the turn runs, and each `result` adds its
exact usage and replaces the estimate (`_add_result_usage`). `transcript_jsonl` counts a message
once too. Turns stored before this keep their old numbers.

## Not done

- The Mini App and the bot have no right rail; they keep their spend sheet (attribution.py).
- Permission waits count as tool time (the JSONL can't see them); bypass mode has none.
- On 2026-11-06 the automatic `/compact` between GRILL and BUILD took 1 s and never reached the CLI
  (no `compact_boundary`), so BUILD started past the zone. The tab now shows that ("compact" sliver
  with no compaction mark); the cause is not chased here.
