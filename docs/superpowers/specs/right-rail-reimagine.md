# Right sidebar, reimagined: a style per tab

Approved 2026-11-05 after four /design-first rounds ("reimagine rightside bar (tabs and content in variants, clocks
and everything), make it cool, useful, simple, each one uniquely amazing").

**Source of truth for the look:** the mockups in the main checkout,
`.mystical/design-drafts/right-rail-reimagine/06-r4-picks.html` (open it in a browser; Turns = column "Turns · A",
not "Turns · B") and the 2x crops `shots/r4-turns-a.png`, `r4-files.png`, `r4-git.png`, `r4-branches.png`,
`r4-rivendell.png`, `r4-team.png`, `r4-usage.png`. The cap and rail are in every crop. Mockups are drawn in the
user's theme (OSGILIATH, Nunito, compact); the build must use theme tokens, never the mock's hex values.

## What stays

- The rail's mechanics from `right-rail-shell`: drag to reorder, hide/show, ⌥1–9, the seam resize, the tab glide, the
  `scope` remount rules, the foot well (go live, changelog, update, ⌘K), group rules.
- Every action a tab has today keeps a way in (a button, a row click, or the existing context menu).
- Theme families keep styling the rail through their structural selectors.
- The 132px `RailHero` frame is no longer used by the tabs below; each tab draws its own top.

## Shell

- **Cap clock:** the time (as today, 12/24h setting kept) followed by a date window: line 1 = weekday + day + month
  in caps (`THURSDAY 5 NOV`), line 2 = `<weather cond, lowercase> · <temp>° · <city>` (`rain · 11° · Yerevan`). The
  city is the first comma part of `weather.loc`, title-cased. No temperature-only readout any more. A click opens the
  Almanac (GLOSSARY.md; the clock menu and the CLOCK & WEATHER popover are gone, their settings live in SETTINGS ▸
  APPEARANCE ▸ CLOCK & WEATHER), and the pinned world clocks keep their place between the date window and the bell. Narrow widths: line 2 truncates with an ellipsis; the date line never
  wraps.
- **Named rail:** every tile shows its icon and, under it, a short name in caps: TURNS, FILES, GIT, BRANCH, LEARN,
  TASKS (Rivendell), TEAM, USAGE (FLOW when the skill-paths tab lands). A tab that wants you prints its readout in the
  name's place, in its tone: `ASK` (turns, --ask), `N EDITS` (git dirty files, accent; the ↑/↓ sync readout stays as
  today when clean), `N NEW` (team), `!` (alert), the usage % only under 25% (warn). Tile height 50px; icon never
  moves. The open tile's name is accent-coloured.

## Tabs

Each tab starts with a slim kicker row (36px): the tab name in small caps, its scope chip if any, its tools on the
right. No 42px title row, no hero box.

### Turns · MOMENTS
- **Now bar** (only while the open session's latest turn waits on you): yellow-tinted strip with "Turn N waits on
  you", the question's text under it, and `Answer ›` which jumps to the ask in the chat (today's jump). While a turn
  runs but doesn't wait: the bar reads "Turn N is working · <elapsed>" in the accent tone with `Go to it ›`. Idle: no
  bar.
- **Stream**, newest turn first, on a vertical line: each turn is a header row (number tile, your prompt on one line,
  `HH:MM · duration`, or `stopped`/`error` in red, yellow tile while it waits). Under it, one line per **moment**:
  - asked you (each question; `→ <answer>` once answered),
  - committed `<subject>` (each successful `git commit`),
  - merged `<branch>` (each successful `git merge` / a merge commit),
  - pushed / published (successful `git push`),
  - opened PR #n (successful `gh pr create`),
  - tests passed / failed (`pytest`, `npm test`, `vitest`, `node --test`, `npm run check` with their result line),
  - stopped / errored (the turn's end, red).
  Each moment line: small round icon in its tone, text, time `HH:MM` right. One line each, same height.
- The three newest turns that have moments list them (newest first, at most 3, then a `+N more` line that expands in
  place); older turns fold theirs into one `N moments` line that expands in place. A turn with no moments shows only
  its header.
- A gap of more than 30 minutes between a turn's end and the next turn's start prints `AWAY 1H 41M` on the line.
- Clicking a header or a moment jumps the transcript to it (today's `onJump`). Copy / Send again stay on the header's
  hover and context menu. Find (⌕) and go-to-latest stay in the kicker.
- The TIME dock is dropped from this tab.

### Files · writing card over today's tree
- **Writing card** (while the open session's running turn has written a file): file-type badge, file name, folder,
  `WRITING` with a pulse; the last 4 lines of the newest landed edit as a mini diff (`+` lines tinted ok, `−` lines
  tinted err, line numbers when the patch carries its hunk start); footer `Open at line N ›` (or `Open ›`) and
  `turn N · <age>`. The bridge only sends an edit's text once the edit lands (`tool_done.patch`), so the card follows
  edit by edit, not keystroke by keystroke. When the turn ends the card reads `WROTE` for 60s, then folds away.
- Under it, today's panel unchanged: Find a file (⌘P) and the tree with its ✦ / ● marks and live pulse.

### Git · DELIVERY TRACKER
- **Tracker card**: a sentence for where the work is ("Your work is still on this Mac" / "Committed, not on origin
  yet" / "Everything is on origin"), a second line naming the next hop(s), a three-stop stepper ON THIS MAC (N files)
  → COMMITTED (N commits) → ON ORIGIN (`up to date` in ok, or `N new` when behind, in --warn with Pull as the button),
  the lit stretch of line up to the stop holding work, and the hop buttons: `Commit N` (primary) and `Publish N`
  (soft). Diverged keeps today's hand-off ruling.
- **In the parcel**: today's changes list (status letter, name, +/−, hover diff/stage/discard), then today's message
  box with ✧ Write it.
- **Waiting to ship**: the unpublished commits (subject, age), `Graph ›` opens today's graph fold.
- Today's readouts (auto-fetch error, Rivendell task line, op results/failure box) sit between the tracker and the
  parcel.

### Branches · DIVERGENCE
- **Base card**: the base branch name, `base`, its live session line, `Push N` when it has unpublished commits.
- `◀ BEHIND MASTER · AHEAD ▶` legend, then one row per branch/worktree: status dot (today's colours), name, the step
  button (today's ruling); line 2 = a divergence bar centred on the base (behind grows left, grey; ahead grows right,
  accent; length `min(56, 14·√n)` px; counts at the bar ends; `merged` text when merged) and the live session line or
  today's facts. Rows one height. Merged group with Clean up all, as today.

### Rivendell · DECK
- Board line (◆ project · N tasks). **Deck**: the next task as a card on two offset cards behind it: `NEXT UP`, `k of
  N`, priority edge colour, title, key + priority + who's on it, the first ~160 characters of its spec, buttons
  `▶ Implement` / `Work on it` and `Skip ›`. Skip moves to the next task (kept per project in localStorage, cleared
  when the list changes order or after 24h).
- **Running**: each running task as a mini card with its step pips and `Open ›`.
- **Then**: the next 4 titles with their keys, plain.
- Every state today's tab has (needs restart, link down, token rejected, asks inline) stays reachable.

### Team · faces, cards, one-line events
- **Faces row**: up to 5 avatars with presence (online ring), then "<name> is on now" + others' last-seen.
- **TODAY / EARLIER** sections: an incoming share is a plain card (avatar, "<name> sent you · HH:MM", kind pill, title,
  note, facts, `Continue here` / `In yours`, today's extra actions in its menu); everything else is one line each with
  an icon: you sent X to Y (status word: OPENED ✓✓ / DELIVERED / WAITING), Y continued X, …
- **Send bar** pinned at the foot: "Send this session to [avatar name ▾]" + send button; the picker lists the roster,
  online first; send goes through today's `setSendWhat` flow. Hidden when there's no open session.
- No chat bubbles.

### Usage · your week, no battery
- No ring, no battery, no % in the tab (the rail tile keeps its ring).
- **Your week**: a 7×24 grid (rows M–S, columns 0–23h), each cell shaded by that hour's turn count, empty future cells
  faint, the current hour outlined; hour labels 0 6 12 18 24; `busiest <Day> HH:00` on the section line; a fewer →
  more scale.
- Four numbers in a 2×2 grid: turns today, agent time today, turns this week, hours this week (+ change vs last week).
- **Where it went**: one stacked bar of project hours in project colours + a two-column legend (name, hours), then
  today's Stopped turns and Tokens folds. This/Last switches the whole tab.

## Out of scope
Inline answering in Turns, all logins in Usage, priority letters / device lines / per-file +/− in the Files tree,
the analog clock, the session ribbon, chat bubbles. The Learn tab keeps its body; it only gains its rail name.
