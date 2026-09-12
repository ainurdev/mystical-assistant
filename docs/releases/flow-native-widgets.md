# A widget per kind of work

A card field used to arrive as text under a label. Now the flow declares what
kind of thing the value is and the card draws it — a diff as hunks, a topology
as nodes, a week of numbers as bars. Thirteen new field types and six new
flows, on the dashboard and the Mini App.

## Added

**Thirteen field types**, grouped by the work they belong to:

- **Code and terminal** — `diff` shows each changed file with its hunk and its +/− counts. `output` shows a command and what it printed, verbatim.
- **Diagnosis** — `chain` lays a root cause out in order: symptom, cause, fix, proof. Each step carries a tone, so a bad link reads as bad.
- **Systems** — `map` draws what talks to what, marking each hop ok, warn or bad. `meters` shows headroom as bars.
- **Numbers** — `chart` plots a value over time, `stats` puts the headline figures in tiles, `table` is columns and rows.
- **Choices** — `ideas` lists directions you can star. `plan` marks each line add, change or drop. `intake` is a grid of questions with their likely answers, which you answer on the card.
- **Research** — `sources` ranks what a search found, badges the official ones and flags the stale ones. `claims` puts one claim per line with the sources it rests on.

A value that isn't the shape its type promised renders as plain text instead.
All or nothing per field — half a board and half a paragraph reads as a bug.

**Six flows:**

- **DATA** — a question about numbers. Pulls from where they actually live, reads them back as a chart, tiles and a table.
- **BRAINSTORM** — diverge into directions that disagree with each other, star the ones worth keeping, converge on what they commit you to.
- **WRITING** — outline, draft, revise. Each pass shows the text and what changed in it.
- **INFRA** — map the path and its health, state what applying would change, apply it, then re-run the same checks to prove it.
- **WEB RESEARCH** — gather sources and triage them, then conclude one cited claim at a time.
- **CLARIFY** — for a brief too thin to act on. Asks what's genuinely undecided, then hands a usable brief to BUILD, DESIGN or BRAINSTORM.

**Two new ways a stage can ask for you.** `pick` stars things on the card;
`answer` fills in the intake grid. Every stage now also shows where it sits on
the engagement ladder — L0 WATCH through L5 CO-EDIT — on the hint line above
the prompt box and on the pinned flow map. You can see whether a stage wants a
glance or a decision before you read what it asks.

## Changed

Existing flows were retyped, not extended:

- BUILD, DESIGN and FIX show a hunk per changed file where they used to list filenames.
- FIX REPRODUCE shows the failing output verbatim, with the command that produced it.
- FIX ROOT-CAUSE draws the cause as a chain instead of a paragraph.
- PROBE REPORT states its answer as cited claims.

Nothing gained a field. Every field a stage declares is required by name, so
adding one would make an old stage stricter without making it better.

## Availability

Live on both surfaces.
