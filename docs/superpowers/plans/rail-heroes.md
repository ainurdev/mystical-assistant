# Rail heroes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every right-rail tab opens with its own 132px "signature hero" in place of the shared three-number readout,
and the Git tab gets the approved PIPE.

**Architecture:** One shared frame component, `RailHero`, fixes the height, chrome and reduced-motion rules. Each tab
gets a small hero component fed by data its panel already holds. Each hero's layout maths is a pure function in
`lib/` with a `*.check.ts`. Lists under the heroes are not touched. Dashboard only; no backend change unless Task 5
finds the Rivendell lanes missing.

**Tech Stack:** React + TypeScript, lucide icons, inline SVG, the theme's CSS variables.

**Spec:** `docs/superpowers/specs/skill-paths.md` §8. Mockups: `.mystical/design-drafts/skill-paths/05-rail-refresh.html`,
and for Git the round-4 crops `shots/g2-{synced,dirty,ahead,diverged}.png` (`07-git-pipe-r4.html`). The FLOW hero is
in the skill-paths plan (Task 8).

## Global Constraints

- Every hero is **132px tall**, in every tab and every state, so switching tabs never moves the list under it. Empty
  and loading states keep the same box.
- Colours only through theme variables (`--acc`, `--acc2`, `--ok`, `--warn`, `--err`, `--txb`, `--txd`, `--txl`, …).
  Amber (`--warn`) means it came from origin or needs you, accent means it's yours to move, and green means running
  or clean.
- Motion (pulse, flowing dashes, breathing blocks) stops under `prefers-reduced-motion: reduce`.
- Each hero has an `aria-label` that reads its state in words. Its one button is a real `<button>`.
- Work in a worktree on `feat/rail-heroes`. One-line commits, no co-author lines, never push. Checks run from
  `bridge/dashboard/web/` with `node src/<file>.check.ts`, plus `npx tsc -p tsconfig.app.json`.
- Every hero must look right in OSGILIATH (dark, as drawn) **and** PEBBLE (light).

## Review Focus

1. **Zero and huge numbers.** A repo with 0 commits, 40 changed files or 120 ahead must keep the layout. Counts above
   99 read `99+`. → Task 1 `gitpipe.check.ts` and Task 3 `footprint.check.ts` cases.
2. **No upstream** (a local-only branch). Git shows "not pushed" and Publish, never "synced". → Task 1.
3. **A session with one turn, or 60.** The turn clock keeps blocks at least 4px wide and labels its hours without
   overlap. → Task 2.
4. **Light theme.** No hard-coded `#fff` on light grounds, except the text on filled buttons. → Task 8.
5. **Tab switch.** The hero height is equal across all 7 tabs (measured). → Task 8.

---

### Task 1: `RailHero` frame + Git PIPE

**Files:**
- Create: `web/src/components/hud/RailHero.tsx`, `web/src/components/hud/GitPipe.tsx`, `web/src/lib/gitpipe.ts`, `web/src/lib/gitpipe.check.ts`
- Modify: `web/src/components/hud/GitPanel.tsx`. Replace the `.gp-rd` readout block with `<GitPipe …/>`, using the
  sync state `s` (kinds `synced | ahead | behind | publish | diverged`), `toPush`, `toPull`, the changed-file count
  and `git.fetched_at` it already computes (:172-349).

**Interfaces:**
- Produces:
  - `RailHero({label, top, children}) -> JSX`: the 132px frame with its top line.
  - `pipe(sync: {kind, ahead?, behind?, n?}, changed: number, hasUpstream: boolean) -> {stations: [{key: "mac"|"branch"|"origin", big: string, sub: string, hot: boolean, warm: boolean}], flows: {gap: 0|1, dir: 1|-1, tone: "acc"|"warn"}[], action: {verb: "Commit"|"Publish"|"Pull", n: number, gap: 0|1, tone: "acc"|"warn"} | null, say: string}`

- [ ] **Step 1: Write the failing check.** `gitpipe.check.ts` covers the four drawn states:
  - synced → `action null`, say `"Everything is on origin"`
  - 5 changed → Commit 5 on gap 0, station mac hot
  - 2 ahead with no upstream → Publish 2 on gap 1, origin big `"—"`, sub `"not pushed"`
  - diverged 1/3 → Pull 3 on gap 1 with tone warn, origin hot and warm, two flows on gap 1
  - plus the Review Focus cases: 120 ahead → big `"99+"`; changed 0 and no upstream → Publish when ahead, else nothing
- [ ] **Step 2: Run it.** Expect FAIL. **Step 3: Implement** `pipe`, then `RailHero` and `GitPipe` as drawn: icons
  `Laptop`/`GitBranch`/`Cloud`, the glow on the hot station, dotted flowing arrows, the button laid across its gap with
  two tick connectors, "NOTHING TO MOVE" when synced, and "checked <age>" from `fetched_at`. The button calls the same
  handlers the panel's existing Commit / Publish / Pull use.
- [ ] **Step 4: Run** the check and tsc, then a capture against `shots/g2-*.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Git tab opens on the PIPE"`

### Task 2: Turns: the session on a clock

**Files:** Create `web/src/components/hud/TurnClock.tsx`, `web/src/lib/turnclock.ts`, `web/src/lib/turnclock.check.ts`;
modify `web/src/components/hud/TurnsPanel.tsx` (the `gp-rdw` readout :205-215 becomes the hero; the counts become its
caption line).

**Interfaces:** `turnClock(turns: {started: number, secs: number, asks: number, running: boolean}[], now: number) -> {from: number, to: number, ticks: {at: number, label: string}[], blocks: {x: number, w: number, n: number, asks: number, running: boolean}[]}`.
`x` and `w` are 0–1 fractions, with `w ≥ 4/275`. Ticks fall on whole hours, or whole days for spans over 36h.

- [ ] **Step 1: Write the failing check.**
  - The real 3-turn session (14:54 1h43m / 16:39 17m / 16:56 running) gives 3 blocks with the third running and ticks
    15:00, 16:00, 17:00.
  - 1 turn gives 1 block.
  - 60 turns over 3 days gives day ticks and no block under 4px.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS) plus tsc, then capture against `shots/r2-turns.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Turns opens on the session clock"`

### Task 3: Files: this session's footprint

**Files:** Create `web/src/components/hud/FilesFootprint.tsx`, `web/src/lib/footprint.ts`, `web/src/lib/footprint.check.ts`;
modify `web/src/components/hud/FilesPanel.tsx` (hero above the search), passing `edited`/`now` from `App.tsx`
(`filesEdits`, :2154).

**Interfaces:** `footprint(edited: Set<string>, now: string | null, root: string) -> {total: number, folders: {name: string, count: number}[], recent: {name: string, now: boolean}[]}`.
Folders are the first two path segments under `root`, the top 4 by count with the rest summed as "other". `recent`
is the last 3 by edit order.

- [ ] **Step 1–4:** The check covers the mock's numbers (apps/web 9, packages/ui 4, e2e 2, docs 1 → 16), 0 edits
  (the hero reads "nothing touched yet" in the same box), and 40 files over 9 folders (4 shown plus "other").
  Then capture against `shots/r2-files.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Files opens on the session's footprint"`

### Task 4: Branches: trunk and forks

**Files:** Create `web/src/components/hud/BranchTrunk.tsx`, `web/src/lib/trunk.ts`, `web/src/lib/trunk.check.ts`; modify
`web/src/components/hud/BranchesPanel.tsx` (hero above WORKTREES), fed from the rows `lib/branchrows` already builds.

**Interfaces:** `trunk(rows: {name: string, state: "waits"|"working"|"pr"|"clean"|"local"|"base"}[]) -> {tips: {name, state, x: number, low: boolean}[], legend: {state, count}[]}`.
There are at most 8 tips, alternating high and low; more than 8 shows "+N" at the end.

- [ ] **Step 1–4:** The check covers the 6-row mock, 1 row (main only), and 12 rows (8 tips and +4). Then capture
  against `shots/r2-branches.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: Branches opens on the trunk"`

### Task 5: Rivendell: the board bar

**Files:** Create `web/src/components/hud/BoardBar.tsx`; modify `web/src/components/hud/RivendellTasks.tsx`.
- [ ] **Step 1: Find out** whether the tasks the tab loads carry a lane or status per task. If yes, count lanes on the
  client. If no, the bar shows two segments (open and done) from what is there. Don't add a backend call for this.
- [ ] **Step 2: Implement** the bar with counts inside the boxes and the linked project with its age, plus a
  "next up" line taking the first open task, whose ▶ uses the existing start action.
- [ ] **Step 3: Run** tsc, then capture against `shots/r2-rivendell.png`.
- [ ] **Step 4: Commit** `git commit -m "dashboard: Rivendell opens on its board"`

### Task 6: Team: the room

**Files:** Create `web/src/components/hud/TeamRoom.tsx`; modify `web/src/components/hud/TeamPanel.tsx`.
- [ ] **Step 1: Implement** up to 5 avatars from the presence the panel already reads: a green ring and live dot when
  on now, dimmed when away, "+N" past 5. Add the Send circle (the panel's existing send action) and a caption naming
  the first person on now and where.
- [ ] **Step 2: Run** tsc, then capture against `shots/r2-team.png`.
- [ ] **Step 3: Commit** `git commit -m "dashboard: Team opens on the room"`

### Task 7: Usage: the 5-hour ring and the week

**Files:** Create `web/src/components/hud/UsageRing.tsx`; modify `web/src/components/hud/UsagePanel.tsx` (the first fold's
readout and chart become the hero).
- [ ] **Step 1: Find** the 5-hour window figure and its reset time where the composer's account meter reads them (the
  get_usage meter from the CLI signals release). If there is none for the open account, the ring shows "—", keeping
  its size.
- [ ] **Step 2: Implement** the ring (amber stroke, % and "5-HOUR" inside, "resets HH:MM" under it), the 7 day bars
  (today lit) and the week total top right.
- [ ] **Step 3: Run** tsc, then capture against `shots/r2-usage.png`.
- [ ] **Step 4: Commit** `git commit -m "dashboard: Usage opens on the 5-hour ring"`

### Task 8: Light theme + no-jump pass

- [ ] **Step 1:** Capture all 7 heroes, plus FLOW once the skill-paths plan has landed, in OSGILIATH and PEBBLE (seed
  `hud-settings` through `PRELOAD`, as in `mac-headless-capture`). Fix any hard-coded colour.
- [ ] **Step 2:** Measure the hero's `getBoundingClientRect().height` in each tab. All must equal 132. Click through
  the tabs and check the first list row's `top` doesn't change between tabs that share a list offset.
- [ ] **Step 3:** Run every `*.check.ts`, tsc and the web build. Then commit
  `git commit -m "dashboard: rail heroes hold in light themes"` and hand off for the user's merge routine and ⟳.
