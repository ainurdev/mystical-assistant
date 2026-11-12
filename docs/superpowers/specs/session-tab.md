# SESSION tab: TURNS and FLOW in one, with where the tokens and the time went

Asked 2026-11-08 (/design-first): "mix flow and turn into one tab … how much token on what, turn and
flows, reimagine and rethink the UI UX". Three directions were drawn on real sessions; the user
picked **B · CURVE** (not the recommended A · CHAPTERS), asked for time beside the tokens, took all
four add-ons, and approved round 2 as drawn. Drafts: `.mystical/design-drafts/session-tab/`
(cards 01–04, SPEC.md). UX pattern: `session-tab`.

## The tab (components/hud/SessionPanel.tsx), quiet since 2026-11-12

Asked 2026-11-12 (DESIGN flow): "less details on first glance and on clicking have more data … all
flows and which is active and how time … each section unique to its purpose". Picked per section,
HORIZON · TRACK · DIAL · BLOCKS · BY FLOW · QUIET ROWS. Drafts:
`.mystical/design-drafts/session-quiet/` (08-picks.html, SPEC.md). Each section is one line until a
click opens it in place, and remembers open or closed (`hud-session-folds`; all start folded). No
token count shows before a click except the window's own number. Top to bottom:

1. **WINDOW (HORIZON)**: its number of the session's max, Compact past the 150k zone, over a 40px
   slim curve: the 150k line, the compactions as ticks, long waits as narrow gaps. Opened: the 62px
   curve, who was working under it, the flows as bands (their steps' starts as hairlines; the turns
   while no flow ran), the clock with only the longest break named, a legend.
2. The now bar (working / waits on you, with Answer).
3. **FLOWS (TRACK)**: one bar, a segment per flow the session ran, oldest left, sized by the time
   worked on it (18px at least). The active flow is striped, a flow another one stopped is hatched;
   ASK, SHIP and each one-skill run fold into one segment where their latest run is. Names (or
   icons, where a segment is narrow) and times under it; the active flow and its step on the right.
   A click on a segment opens why the flow started, its steps as stops on a line with the time and
   tokens of each (a folded segment: its runs), and on the active flow NEXT, AUTO and Skip on a
   REVIEW. A flow's time is the worked seconds from its first turn to the next turn's start.
4. **TIME (DIAL)**: a ring and "9h 50m worked of 23h 15m"; opened, a big ring and the five times.
5. **ON WHAT (BLOCKS)**: one sentence on what fills the window ("Mostly start-up (40%), then Claude
   wrote and files read"); opened, the WINDOW / SPENT switch over a treemap of the kinds, a block
   opening its three biggest items (each opens the turn it came in).
6. **HELPERS (BY FLOW)**: a face pile, "33 ran · 2 running"; opened, the helpers under the flow
   whose turn started them, newest flow first, running first; a tap opens its run in AGENTS.
7. **TURNS (QUIET ROWS)**: number, prompt, time. Marks, spend, copy and send again show on hover;
   a click jumps; find, ⌥↑/⌥↓ and the lit row that follows the chat stay.

## The flows a session ran (bridge/paths.py `past`, GET /local/flow)

A session follows one flow at a time (GLOSSARY: Flow). When another takes its place, flows.json
keeps the old one in the session's record: who started it and why, `at`, its end, its steps as
they stood, the ones done and skipped, and the step it stopped on (null when it ran to its end; a
flow that ends records `end` when its last step is done). `restore()` takes back the one a refused
run pushed. GET /local/flow sends them as `past`, oldest first, beside the current flow. A turn
belongs to the latest flow begun by its end, unless that flow had ended before the turn began;
turns before the first flow, or after one ended, count only in TIME. The bridge keeps `at` and a
turn's length in whole seconds, so a flow begun in a turn's last second (a prompt queued behind
it) isn't that turn's (lib/meter flowOfRows). A turn's own SHIP, ASK, review or audit step ends
before the queue starts the prompt behind it (paths.end_turn_step), so a flow that prompt starts
finds the one before it finished. The last 50 flows are kept.

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
