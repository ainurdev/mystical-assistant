# Right rail reimagined Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every right-rail tab the style its job needs (Turns MOMENTS, Files writing card, Git DELIVERY
TRACKER, Branches DIVERGENCE, Rivendell DECK, Team faces + cards + send bar, Usage week grid), with a date clock in
the cap and names under the rail's icons.

**Architecture:** Each tab keeps its panel component and loses its 132px hero. Its new top is a small component fed
by data the panel already holds, and its decisions are a pure function in `lib/` with a `*.check.ts`. One shared
`TabKick` replaces the per-panel title rows. The only backend change is a 7×24 turn grid on `/local/report`.

**Tech Stack:** React 19 + TypeScript, lucide-react, inline SVG, theme CSS variables; Python stdlib + SQLite (report).

**Spec:** `docs/superpowers/specs/right-rail-reimagine.md`. Mockups (main checkout, git-ignored):
`/Users/mhzrerfani/Projects/mystical-assistant/.mystical/design-drafts/right-rail-reimagine/06-r4-picks.html`
(column "Turns · A" is the Turns design) and `shots/r4-{turns-a,files,git,branches,rivendell,team,usage}.png`.

## Global Constraints

- Work in `/Users/mhzrerfani/Projects/.worktrees/mystical-assistant/feat-right-rail-reimagine` on
  `feat/right-rail-reimagine`. One-line commit messages, **no Co-Authored-By or any attribution line**, never push.
- Web commands run from `bridge/dashboard/web/`: checks `node src/lib/<name>.check.ts` (use the throwing `ok()`
  helper from `rail.check.ts`, never `console.assert`), typecheck `npx tsc -p tsconfig.app.json --noEmit`, build
  `npx vite build --outDir /tmp/rrr-wt-dist --emptyOutDir` (never into the served `dist`).
- Backend: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q`. Baseline 3601 passed, 3 known macOS reds
  (`test_clip_panel::test_clip_marks_round_trip`, two in `test_startup.py`). Anything else red is ours.
- Colours only through theme variables (`--acc`, `--ask`, `--ok`, `--warn`, `--err`, `--tx*`, `--panel*`, `--line*`).
  `--ask` means "waits on you" and nothing else; incoming-from-origin is `--warn`.
- Rows in one list share one height. A tab switch never moves the column (no hero box to keep equal any more, but the
  kicker row is 36px in every tab).
- Pulses and moving dots stop under `prefers-reduced-motion: reduce`.
- Never add a wrapper element inside `RightPanel`'s rail column: theme families style it through
  `.hudgrid > div:last-child > div:last-child > div:last-child` (index.css ~4838, ~7084, ~6984–7000, 6383–6411).
- Keep `RailHero.tsx` and the `.rh*` CSS: the skill-paths branch's FLOW tab still uses them. Delete each other hero
  component (and its lib + check) only when nothing imports it any more.
- Every tab must read right in OSGILIATH (dark) and PEBBLE (light) at the default width and at 230px.

## Review Focus

1. **Turns loaded from a tail.** Turns before the cut have `events: []` (only `sum`): they show their header and no
   moments, never a crash or "0 moments". → Task 4 check case.
2. **Odd Bash results.** `git commit` that printed "nothing to commit", an amend, a merge with conflicts
   (`is_error`), a test run whose output was cut at 2000 chars: no false "committed"/"merged"/"tests pass". → Task 4.
3. **Git states beyond the mock.** Clean + synced, no upstream (Publish), behind only (Pull, `--warn`), diverged
   (today's hand-off), never fetched: the tracker's sentence and buttons stay true. → Task 6 check.
4. **Long names at 230px.** A 40-char branch, file or city name truncates with an ellipsis; nothing wraps to a second
   line in a one-line row; the cap's date line never wraps. → Tasks 1, 7, 10 captures.
5. **Empty and broken data.** No roster or a team error, Rivendell with 0 tasks or its link down, a report without
   `hours` (old bridge): each tab shows today's empty/error state in the new layout. → Tasks 3, 8, 9.

---

### Task 1: Shell — named rail, date cap, `TabKick`

**Files:**
- Create: `bridge/dashboard/web/src/lib/capdate.ts`, `lib/capdate.check.ts`, `components/hud/TabKick.tsx`
- Modify: `components/RightPanel.tsx` (`PanelTab` + tile JSX :39-74, :277-311), `App.tsx` (`rightTabs` :2391-2505),
  `components/hud/Strip.tsx` (temperature button :337-354), `index.css` (rail rules listed in Global Constraints)

**Interfaces:**
- Produces: `capDate(now: Date, w: Weather) -> { date: string; line2: string }`;
  `PanelTab.short?: string`; `TabKick({ name, chip, tools }: { name: string; chip?: ReactNode; tools?: ReactNode }) -> JSX`
  (36px row: name in small caps `--txl`, chip after it, tools right-aligned).

- [ ] **Step 1: Write the failing check** `capdate.check.ts`:
  - `capDate(new Date(2026, 10, 5, 20, 32), {cond: "RAIN SHOWERS", temp: 11, loc: "YEREVAN, YEREVAN, AM", …})` →
    `{date: "THURSDAY 5 NOV", line2: "rain showers · 11° · Yerevan"}`
  - `temp: null` → line2 `"rain showers · Yerevan"`; `available: false` → line2 `""`
  - `loc: "rio de janeiro, RJ, BR"` → city `"Rio De Janeiro"` (first comma part, title case)
- [ ] **Step 2: Run** `node src/lib/capdate.check.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `capDate`; replace the temperature button with a two-line date window inside the same
  button (same click → clock menu; `data-ctx-type="weather"` kept), `date` at t9/800/1.4px tracking, `line2` at
  t11 `--txl`, both `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`, a 1px `--line2` rule left of it.
- [ ] **Step 4: Named rail.** Add `short` to every tab in `App.tsx`: TURNS, FILES, GIT, BRANCH, LEARN, TASKS (rivendell),
  TEAM, USAGE. In `RightPanel`, under the icon print `word` when there is one, else
  `<span className="rtile-n">{t.short ?? t.label.toUpperCase().slice(0, 6)}</span>`; tile height 46→50px; git's
  `badge` text becomes `${n} EDITS` when it counts dirty files (`railCount` path), team's `${n} NEW`. CSS: `.rtile-n`
  t8.5/800/.6px tracking `--txg`, the open tile's `.rtile-n` in `--acc`; update the middle-earth/pebble rules that pin
  button heights so `button.rtile` is 50px there too.
- [ ] **Step 5: Create `TabKick`** (no panel uses it yet — Tasks 3–9 swap it in).
- [ ] **Step 6: Run** the check, tsc, the build; capture the column (OSGILIATH, PEBBLE, 230px) with the roserve kit
  (`.mystical/probe-mac/follow/roserve.mjs` + `.mystical/design-drafts/turns-tab/_probe/steps.mjs`, as in
  `.mystical/archive/feat-rail-heroes/sdd/cap-all.sh`) and compare with the mock's cap and rail.
- [ ] **Step 7: Commit** `git commit -m "dashboard: date clock in the cap, names under the rail's icons"`

### Task 2: Backend — a 7×24 turn grid on the weekly report

**Files:** Modify `bridge/store.py` (next to `week_by_day` :1338), `bridge/report.py` (`weekly` :125, `days` :146),
`bridge/dashboard/web/src/api.ts` (`WeeklyReport`); Test `tests/test_report.py`.

**Interfaces:** Produces `store.week_by_hour(chat_id: int, since: float, until: float) -> list[list[int]]` (7 rows
Monday→Sunday × 24 hours, local time) and `weekly(...)["hours"]` with that value; TS `WeeklyReport.hours?: number[][]`.

- [ ] **Step 1: Write the failing test** `test_week_by_hour_counts_turns_per_weekday_and_hour`: insert turns at
  Mon 00:30, Tue 14:05, Tue 14:50, Sun 23:59 (local) for one chat and one at Tue 14:10 for another chat; assert
  `grid[0][0] == 1`, `grid[1][14] == 2`, `grid[6][23] == 1`, `sum(map(sum, grid)) == 4`, `len(grid) == 7`,
  `all(len(r) == 24 for r in grid)`. Plus `test_weekly_report_carries_hours`: `weekly(chat)["hours"]` is 7×24.
- [ ] **Step 2: Run** `pytest tests/test_report.py -q` — expect FAIL.
- [ ] **Step 3: Implement** with the `week_by_day` JOIN/WHERE, grouped by `strftime('%w', …, 'localtime')` and `%H`;
  map SQLite's Sunday=0 to row 6 (`(w + 6) % 7`).
- [ ] **Step 4: Run** the two tests, then the full suite (baseline above).
- [ ] **Step 5: Commit** `git commit -m "report: turns per weekday and hour for the usage grid"`

### Task 3: Usage — your week leads, no battery

**Files:** Create `lib/weekgrid.ts`, `lib/weekgrid.check.ts`, `components/hud/WeekGrid.tsx`; Modify
`components/hud/UsagePanel.tsx` (drop `UsageRing` :89 and the `win` prop if nothing else needs it; App.tsx :2502);
delete `components/hud/UsageRing.tsx` once unused (keep `lib/usagering.ts` functions still imported by App).

**Interfaces:** Consumes `WeeklyReport.hours` (Task 2), `TabKick` (Task 1). Produces
`weekGrid(hours: number[][] | undefined, now: Date, back: number) -> { cells: { v: number; shade: number; future: boolean; now: boolean }[][]; busiest: { day: number; hour: number; n: number } | null }`
(`shade` 0–1 = `(v / max) ** 0.6`, 0 for v = 0; `future` true for cells after `now` in this week, none when `back > 0`).

- [ ] **Step 1: Write the failing check** with the real week: rows
  `[[2,1,0,…],[…25 at 14…],…]` (copy from `06-r4-picks.html`'s `WEEK`), now = Thu 20:32 → busiest `{day: 1, hour: 14, n: 25}`,
  cell Thu 20 `now`, Thu 21 `future`, Fri all `future`, max cell `shade 1`; `hours` undefined → all zero, busiest null;
  `back: 1` → no future/now cells.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `weekGrid`, then `WeekGrid` (rows M–S, 24 cells 15px tall, hour
  labels 0 6 12 18 24, `busiest <Day> HH:00`, fewer→more scale) and the panel: `TabKick` USAGE with the This/Last
  switch, YOUR WEEK, a 2×2 of turns today / agent time today / turns this week / hours this week (+ change vs last),
  WHERE IT WENT as one stacked bar of `projects` + two-column legend, then the existing Stopped turns and Tokens
  folds. No ring, no % anywhere in the tab.
- [ ] **Step 4: Run** the check, tsc, build; capture vs `shots/r4-usage.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Usage leads with your week, no battery"`

### Task 4: Turns — MOMENTS

**Files:** Create `lib/moments.ts`, `lib/moments.check.ts`; Modify `components/hud/TurnsPanel.tsx` (replace the
`TurnClock` hero :153/:210, the row list and the TIME dock); delete `TurnClock.tsx`, `lib/turnclock.ts(+check)` and
the TIME dock code/CSS (`.tt-*`) once unused.

**Interfaces:** Consumes `TurnRow` (`lib/checkpoints.ts:40`), `Turn.events` (`chat.ts:11`; tool events `{type:"tool",
id, name, summary, detail?}`, results `{type:"tool_done", id, output?, is_error?, patch?}`), `TabKick`. Produces
`moments(row: TurnRow, turns: Turn[]) -> Moment[]` with
`type Moment = { kind: "ask" | "commit" | "merge" | "push" | "pr" | "tests" | "end"; text: string; at: number | null; tone: "ask" | "acc" | "ok" | "err"; jump: string }`
(`jump` = the turn id or the sub's key the row would jump to), newest first.

- [ ] **Step 1: Write the failing check.** Build turns from literal events:
  - Bash `git commit -m "x"` with output `[feat/skill-paths 1a2b3c4] paths: per-session flow state` → commit,
    text `"paths: per-session flow state"`, tone acc
  - same with output `nothing to commit, working tree clean` → no moment
  - `git merge feat/skill-paths` ok → merge `"feat/skill-paths"`; with `is_error` → no moment
  - `git push` ok → push; `gh pr create …` output `https://github.com/o/r/pull/112` → pr `"#112"`
  - `python3 -m pytest tests/ -q` output ending `3564 passed in 19.1s` → tests `"3,564 passed"` tone ok;
    `2 failed, 10 passed` → tests tone err; output cut (no summary line) and not `is_error` → no moment
  - an open question sub → ask, tone ask; an answered one → text ends `→ <pick>`
  - a stopped row → `end` tone err; a row whose turns have `events: []` → `[]`
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `moments` (pair tool/tool_done by `id` across all of `row.ids`'
  turns; command = `detail ?? summary`), then the panel: `TabKick` TURNS + count + find + latest; the now bar (waits →
  `--ask`, "Turn N waits on you", the open question's label, `Answer ›` = today's jump to the ask; running → accent
  "Turn N is working · <elapsed>", `Go to it ›`; idle → none); the stream newest first on a 2px line: header rows
  (number tile, prompt, `HH:MM · duration` or red `stopped`), moment rows 28px, the three newest turns with moments
  list ≤3 then `+N more`, older ones fold to `N moments`, an `AWAY 1H 41M` row for gaps over 30 min. Rows keep today's
  jump, hover Copy / Send again and context menu. Find mode keeps working over prompts.
- [ ] **Step 4: Run** the check, tsc, build; capture vs `shots/r4-turns-a.png` on a real session with commits.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Turns shows the moments that mattered"`

### Task 5: Files — the writing card over today's tree

**Files:** Create `lib/writing.ts`, `lib/writing.check.ts`, `components/hud/WritingCard.tsx`; Modify
`components/hud/FilesPanel.tsx` (hero at :315 → `WritingCard`; header → `TabKick`), `App.tsx` (pass the open
session's `turns` or the derived card into FilesPanel near :2421); delete `FilesFootprint.tsx`,
`lib/footprint.ts(+check)` once unused.

**Interfaces:** Produces
`writing(turns: Turn[], root: string | null, now: number) -> { path: string; name: string; dir: string; lines: { sign: "+" | "-" | " "; text: string; n: number | null }[]; line: number | null; turn: number; at: number; live: boolean } | null`
— the newest write tool (`toolKind(name) === "write"`, as `lib/sessionedits.ts`) in the open session whose
`tool_done.patch` exists; `lines` = its last 4 `+`/`-` lines; `n`/`line` from a `@@ -a,b +c,d @@` header when the
patch has one (else null); `live` while that turn runs; null when the turn ended over 60s ago or nothing was written.

- [ ] **Step 1: Write the failing check:** a running turn with two Edits on `bridge/skills.py` (patch with an `@@ -210,3
  +210,4 @@` header) → the second edit, `line 212`-ish per header, 4 lines, `live true`; the turn ended 30s ago →
  `live false`; ended 90s ago → null; a Write with no `patch` → skipped; nothing written → null; path outside root →
  shown relative when inside, as-is otherwise.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, then `WritingCard` as drawn (badge from the file icon helper
  `lib/fileicon.tsx`, `WRITING`/`WROTE`, mini diff in `--mono`, `Open at line N ›` via the panel's `onOpenFile`), and
  the panel: `TabKick` FILES + branch chip + today's tools, the card, then today's find + tree untouched.
- [ ] **Step 4: Run** the check, tsc, build; capture vs `shots/r4-files.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Files shows the file being written over the tree"`

### Task 6: Git — DELIVERY TRACKER

**Files:** Modify `lib/gitpipe.ts` (+ check), `components/hud/GitPanel.tsx` (hero :468, sections); Create
`components/hud/GitTracker.tsx`; delete `GitPipe.tsx` once unused.

**Interfaces:** Consumes `pipe(...)` (`lib/gitpipe.ts:20`, already returns `stations`, `action`, `push`, `say`) and the
panel's `heroAct(verb, n)` / `sync(kind, n)` / `generate()` / `commit()`. Produces
`track(p: Pipe) -> { say: string; next: string; at: -1 | 0 | 1 | 2; stops: { key: "mac" | "branch" | "origin"; label: string; value: string; tone: "acc" | "ok" | "warn" | "dim" }[] }`.

- [ ] **Step 1: Extend `gitpipe.check.ts`:** 3 changed + 12 ahead → say `"Your work is still on this Mac"`, next
  `"next hop: commit 3 files, then publish 12 commits"`, at 0, stops values `3 files` / `12 commits` / `up to date`;
  clean + 2 ahead → `"Committed, not on origin yet"`, at 1; clean synced → `"Everything is on origin"`, at -1, no
  buttons; behind 3 → origin stop `3 new` tone warn, at 2; no upstream → origin `not pushed`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `track`, then `GitTracker` (sentence, next line, 3-stop stepper
  with the lit stretch up to `at`, buttons from `p.action` primary + `p.push` soft calling the same handlers the PIPE
  used) and reorder the panel: `TabKick` GIT + branch chip + `checked <age>` + ⟳; tracker; today's readouts (fetch
  error, task line, op results); IN THE PARCEL = today's changes list + message box + ✧; WAITING TO SHIP = unpublished
  commits from the log (`refs`/upstream), `Graph ›` toggles today's graph fold.
- [ ] **Step 4: Run** check, tsc, build; capture vs `shots/r4-git.png` plus a clean repo and a behind one.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Git tracks your work like a parcel"`

### Task 7: Branches — DIVERGENCE

**Files:** Create `lib/divergence.ts`, `lib/divergence.check.ts`; Modify `components/hud/BranchesPanel.tsx` (hero
:305 → base card; rows); delete `BranchTrunk.tsx` once unused (keep `lib/trunk.ts`'s `trunkState` while used).

**Interfaces:** Consumes `ShownRow`, `nextStep`, `stepLook` (unchanged). Produces
`divergence(r: { ahead: number; behind: number; landed: boolean }) -> { left: number; right: number; behind: string; ahead: string; merged: boolean }`
(px = `min(56, 14 * Math.sqrt(n))`, 0 for n = 0; labels `""` for 0, `"99+"` above 99).

- [ ] **Step 1: Write the failing check:** 12 ahead → right ≈ 48.5, left 0; 5 behind 2 ahead → left ≈ 31.3,
  right ≈ 19.8; 77 → 56 (cap); 150 → label `"99+"`; landed → merged true, widths 0.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, then the panel: `TabKick` BRANCHES + `+ Branch` + ⟳; the base card
  (base name, `base`, its live session line from the same `sess`/`live` maps, `Push N` when the base has unpushed);
  the `◀ BEHIND MASTER · AHEAD ▶` legend (base name, not "master", when it differs); each row: today's dot + name +
  step button on line 1, the bar (118px, centre rule, faint track, counts at the ends, `merged` text) + session line or
  facts on line 2; groups and Clean up all as today.
- [ ] **Step 4: Run** check, tsc, build; capture vs `shots/r4-branches.png` at default width and 230px.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Branches shows how far each branch drifted"`

### Task 8: Rivendell — DECK

**Files:** Create `lib/deck.ts`, `lib/deck.check.ts`, `components/hud/TaskDeck.tsx`; Modify
`components/hud/RivendellTasks.tsx` (hero :262 → deck; NEXT UP todolist view :323 folds into the deck order);
delete `BoardBar.tsx`, `lib/boardbar.ts(+check)` once unused.

**Interfaces:** Consumes today's NEXT UP choice (`nextUp`, `lib/rivendelltasks.ts:151`, and the hero's ▶ fallback
:258-259), `api.rivendellTask(instance_id, id)` for the spec. Produces
`deck(open: RivendellTask[], nextIds: string[], skipped: Record<string, number>, now: number) -> RivendellTask[]`
(next-up ids first in their order, then the rest as today's needs → mine → team order; skips younger than 24h move to
the end) and `excerpt(md: string, n = 160) -> string` (markdown stripped to plain text, cut at a word with `…`).

- [ ] **Step 1: Write the failing check:** ordering with 2 next-up ids; a skip 1h old moves that task last; a skip
  25h old is ignored; `excerpt("## Why\n**p95** went from 380 ms…", 40)` → `"Why p95 went from 380 ms…"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, then `TaskDeck` (top card on two offset cards: NEXT UP, `k of N`,
  priority edge, title, key · priority · who, excerpt, `▶ Implement` / `Work on it` / `Skip ›` — the first two call
  today's handlers, Skip writes `localStorage["rv-skip:<project>"]`), RUNNING mini cards with step pips + `Open ›`,
  THEN = next 4 titles. Keep every banner/error/empty state and inline asks above or in place of the deck.
- [ ] **Step 4: Run** check, tsc, build; capture vs `shots/r4-rivendell.png` on a linked project (apex).
- [ ] **Step 5: Commit** `git commit -m "dashboard: Rivendell deals the next task as a card"`

### Task 9: Team — faces, cards, one-line events, a send bar

**Files:** Create `lib/teamfeed.ts`, `lib/teamfeed.check.ts`, `components/hud/SendBar.tsx`; Modify
`components/hud/TeamPanel.tsx` (hero :330, sections), `App.tsx` (TeamPanel props if the send bar needs the session);
delete `TeamRoom.tsx` once unused (reuse `lib/room.ts` for the faces).

**Interfaces:** Consumes `TeamOverview` (`api.ts:1008-1080`), `onSendTo(t: Teammate)`. Produces
`teamFeed(team: TeamOverview, now: number) -> { today: FeedItem[]; earlier: FeedItem[] }` with
`type FeedItem = { kind: "share"; r: Received } | { kind: "line"; icon: "send" | "msg"; who: string; text: string; status: string | null; tone: "ok" | "dim"; at: number }`
— undismissed inbox shares as cards, outbox as "You sent X to Y" with OPENED ✓✓ / DELIVERED / WAITING, continued or
opened inbox items as "Y continued X"; newest first; today = same local day as `now`.

- [ ] **Step 1: Write the failing check:** the staged inbox share (today) → today[0] share; an outbox share opened 10
  days ago → earlier line, status `OPENED ✓✓` tone ok; a continued inbox item → `"Mahdi continued NR Kantoor Project
  Status · v2"`; dismissed → absent; empty overview → both lists empty.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, then the panel: `TabKick` TEAM + ⟳; faces row (≤5 from `room()`,
  online ring) + "<name> is on now" + others' last seen; TODAY / EARLIER sections (share card with today's actions;
  lines 1 row each); `SendBar` pinned at the foot ("Send this session to" + picker, online first, + send → `onSendTo`),
  hidden without an open session. Keep receiving progress and the error/empty states. No bubbles.
- [ ] **Step 4: Run** check, tsc, build; capture vs `shots/r4-team.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Team as faces, cards and a send bar"`

### Task 10: Light theme, 230px and the whole-column pass

- [ ] **Step 1:** Capture all tabs in OSGILIATH and PEBBLE at the default width and at 230px (seed `hud-settings`
  through `PRELOAD`; `rightW: 230`). Fix any hard-coded colour, wrap or overlap.
- [ ] **Step 2:** Measure: every kicker row 36px; rows within each list one height (`getBoundingClientRect`).
- [ ] **Step 3:** `grep` for imports of the deleted heroes and libs (none left); `RailHero` still exported.
- [ ] **Step 4:** Run every `src/lib/*.check.ts`, tsc, the build, and the full pytest (baseline). Commit
  `git commit -m "dashboard: rail tabs hold in light themes and narrow widths"` and hand off for the user's merge
  routine and ⟳ (bridge-ship).
