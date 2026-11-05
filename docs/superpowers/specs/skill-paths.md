# Skill paths, tickets and the rail refresh

Status: design, 2026-11-05. Follows `docs/superpowers/specs/skill-router.md` (the rules router, shipped 11-04).
Mockups (git-ignored, on this Mac): `.mystical/design-drafts/skill-paths/`. They are `04-flow-tickets.html` (FLOW + TICKETS),
`05-rail-refresh.html` (one hero per rail tab) and `06-git-pipe.html` plus `shots/g2-*.png` (the Git hero, final round).
The kit that draws states into the live dashboard is `_probe/mock2.js`.

## Why

The skill router puts one of Matt Pocock's `/commands` in front of a prompt. The user wants more than that: every prompt
should get a **path**, meaning the sequence of Matt's skills that gets the best result for it, and Mystical should walk
that path. Three things stand in the way today:

1. The skills arrive as a plugin the user installs (`claude plugin install mattpocock-skills@…`). The user wants
   them to be part of Mystical, behind a switch, with nothing to add.
2. Rules only catch the prompts they were written for. A vague prompt gets no path at all. Unrouted, Matt's skills
   fired 0 of 3 times in the 11-04 bench.
3. A flow stops after every step until the user taps the next command. Tickets become, at best, a suggestion
   to open one fresh session at a time.

The user's words (2026-11-05): "choose a path for prompt when entered by user, based on matt skill we can detect the
flow and go that way with support for all skills that it adds, we want this as mystical feature not skills that can be
add … also ticketing should be feature as well that will create more sessions".

## Decided with the user (cards, 2026-11-05)

| Question | Answer |
|---|---|
| How a path is picked | Today's rules first. When no rule fits, **Claude picks the path itself** from Matt's map at the start of the turn. No extra model call. Bench it before shipping. |
| After a step ends | The next step **starts by itself** unless the user is needed. |
| Where tickets live | **Inside Mystical**: in the project's `.mystical/`, never committed. No setup step in the repo. |
| How tickets run | **Parallel**: one session per ticket, each in its own worktree, **3 at once**. |
| Merging | **All at the end**: a dependent ticket branches off its blocker's branch, and everything is merged in one pass when the last ticket is done. |
| Where the views go | **C · SPLIT**: FLOW is a right-rail tab (it is about one session, like Turns). TICKETS is a sidebar tab (every ticket is a session, the way Plugins lists the sessions a worker started). |
| Look | Their own look, not Turns rows and session rows reused. FLOW is a **path map**. TICKETS is **ticket stubs plus a dependency graph**. |
| Rail refresh | Every right-rail tab opens with a **signature hero** in place of the shared three-number readout. |
| Git hero | **A · PIPE**, then "make it better" → round 4 (`shots/g2-*.png`). |

## Goals

- One switch turns on Matt's 27 skills inside every run Mystical starts. Nothing to install, on any of the three accounts.
- Every prompt without a `/command` gets a path when one fits, and plain questions get none.
- A path walks itself. The next step starts when the last one ends, and the flow stops only where the user must
  answer or approve.
- Approved tickets become sessions that build in parallel and come back merged on one feature branch.
- The user sees where every path and every ticket stands, on the dashboard, at a glance.
- The rail tabs each read as their own thing.

## Non-goals (this round)

- Publishing tickets to GitHub, Linear or Rivendell. Tickets stay inside Mystical.
- Merging the feature branch into `master`, and any push. Those stay the user's own routine.
- New tabs on the phone. Bot and Mini App get the behaviour (paths, auto steps, ticket sessions and their asks as
  notices), not the FLOW/TICKETS views.
- A path editor, user-defined paths, or skills beyond Matt's pack.
- Tests of the tickets' code beyond what each ticket's own `/implement` and the MERGE session run.

## Anti-goals (a failure even if it "works")

- A path started on a plain question ("what does X do?"). A false start costs a grill the user never wanted.
- An automatic step that publishes, pushes or touches `master`.
- Two ticket sessions writing in the same checkout, or a ticket's work lost in the merge.
- Prompt-cache churn: a per-turn line in the system prompt (see `_compose_system_prompt` in runner.py; packs must
  stay byte-identical turn to turn).
- A rail that jumps when switching tabs. Every hero is the same height.

## Constraints

- Backend: Python stdlib only, no new dependencies. Dashboard: the existing React app and components.
- The running bridge is a snapshot: everything ships through ⟳ (bridge-ship skill). A session can't restart its own bridge.
- New persisted data stays off the live DB while building (bridge-worktree skill).
- `tests/conftest.py` pins config before import; new env flags get pinned there.
- External MCP servers stay off by default. The in-session `mystical-goals` server (bridge/goal_mcp.py) is
  Mystical's own and already spawned per interactive run, so it is the place for new in-run tools.
- The user's rules: never push, never commit onto `master` without the merge routine, one-line commit messages.

## 1. Bundled skills: the SKILL PATHS switch

- Vendor Matt's pack (MIT) into the repo, in a folder of the builder's choosing, e.g. `bridge/skills/mattpocock/`.
  Keep its `.claude-plugin/plugin.json`, `LICENSE` and the `skills/` tree, and leave out `node_modules`, scripts and
  docs. Record the source version and commit (today v1.3.1 from claude-plugins-official) in a README there.
- While the switch is on, every `claude` run the bridge starts (dashboard, bot, Mini App, jobs, ticket sessions)
  gets `--plugin-dir <that folder>`. The 11-04 bench used `--plugin-dir`, and it works on OAuth.
- `bridge/commands.py` lists the bundled skills in the `/` list while the switch is on (`_manifest_skills` already
  reads a manifest).
- **Name clash (verify first):** the user has the same pack installed under the same plugin name. Before building
  on it, check what the CLI does when `--plugin-dir` and an installed plugin share a name. If the result is
  doubled skills or an error, the bridge disables the installed copy for its own runs
  (`--settings {"enabledPlugins": {"mattpocock-skills@claude-plugins-official": false}}`, merged into the
  `--settings` runner.py already builds). Then the installed plugin can be uninstalled, with the user's OK.
- **Unlocked starts:** the vendored copy flips `disable-model-invocation` to false on the skills that start a path,
  so Claude can begin one: `grill-with-docs`, `grill-me`, `improve-codebase-architecture`, `teach`. Steps that
  publish, build or hand off (`to-spec`, `to-tickets`, `implement`, `implement-spec`, `handoff`, `retro`,
  `to-questionnaire`, `wait-what`, `ask-matt`, `setup-matt-pocock-skills`) stay user-only, and Mystical starts them
  as `/commands` (section 3). `triage` and `wayfinder` also stay user-only: triage works on issues in a real tracker
  (labels and comments are publishing) and wayfinder pushes `research/*` branches. Rules still suggest both, never
  auto, and each runs as a one-step path. *My call.*
- **Tracker provided:** while the switch is on, one constant system-prompt line tells the skills what
  `/setup-matt-pocock-skills` would have written. The tracker is local files: one ticket per file at
  `.mystical/tickets/<feature-slug>/<NN>-<slug>.md` in the session's checkout, in the pack's local ticket template,
  with its triage labels. No `docs/agents/` and no CLAUDE.md block in the repo.

## 2. Picking a path

Rules first, exactly as `bridge/route.py` does today: a confident rule puts the command in the box (auto for the safe
set, a suggestion for the rest). A prompt that already starts with `/` is left alone.

When no rule fits and the prompt is sent as typed, Claude picks. One constant system-prompt pack (only while the
switch is on, about 250 tokens) carries Matt's map as the paths table below, plus three instructions:

1. Before acting on a prompt with no `/command` in front, decide whether a path fits.
2. If one does, call the new `SetPath` tool (path + one-line why), then start the path's first skill with the Skill tool.
3. If none fits, just answer. A plain question, a small edit or a chat reply gets no path.

| Path | Starts on | Stations (who moves it) |
|---|---|---|
| FEATURE | a new feature or idea | GRILL `grill-with-docs` (you) → SPEC `to-spec` (auto) → TICKETS `to-tickets` (you approve) → BUILD tickets (auto) → MERGE (auto) → RETRO `retro` (auto). If the grill concludes the work fits one session, the path becomes GRILL → BUILD here `implement` → RETRO. |
| BUG | something broken, an error, a regression | DIAGNOSE `diagnosing-bugs` → FIX `tdd` → RETRO |
| REFACTOR | tangled code, architecture | IMPROVE `improve-codebase-architecture` (you) → TICKETS → BUILD → MERGE → RETRO |
| ONE STEP | research, prototype, review, PR, teach, wizard, writing for agents, questionnaire, domain modelling, codebase design; and `triage` / `wayfinder` when the user takes the rule's suggestion | that one skill |

`SetPath` and `StepDone` (section 3) are new tools on the `mystical-goals` MCP server. They are listed only while
SKILL PATHS is on, the same way the Rivendell tools are listed only where they work. A rule pick records its path
with "picked by rule" and the rule's own why (`_WHY` in route.py).

**A declined pick stays declined.** When the user takes a rule's pick out (Esc), the dashboard sends the prompt with
a flag, and the runner puts one line before the text ("No path for this message."), so Claude doesn't start the same
path anyway. It goes in the prompt and never the system prompt, so the cache is untouched. *My call.*

**Bench before shipping this part.** Re-run the 11-04 bench (`.mystical/skill-bench/bench.py`; point it at the
vendored folder) with the pack in the system prompt and 12 unrouted prompts: 3 bugs, 3 vague features, 2 research
asks, 1 review ask and 3 plain questions. It passes when ≥10 of 12 get the right path (or rightly none), the plain
questions get **0** false starts, and the cost per prompt rises by no more than ~15%. If it fails, the rules-only
router keeps working, and this part waits.

## 3. Next steps start by themselves

- A step ends when Claude calls `StepDone` (optionally naming the branch taken, e.g. FEATURE's "one session" vs
  "tickets"). The constant system-prompt pack asks for that call when a step's work is finished and nothing is
  needed from the user.
- On `StepDone`, if the session's auto is on, the bridge starts the next station's command as the session's next
  turn (`/mattpocock-skills:to-spec`, …), through the same path a queued prompt takes. SMART ZONE still applies:
  past 150k tokens, `/compact <keep the decisions so far>` goes first. BUILD and MERGE start ticket machinery
  (section 4) instead of a turn here.
- If a turn ends **without** `StepDone` (it asked a question in prose, failed or was stopped), nothing starts by
  itself. The composer falls back to today's ghost suggestion of the next command.
- An open AskUserQuestion is "the user is needed". The step waits for the answer and continues inside its own turn.
- Auto can be held per session: the AUTO pill in FLOW's hero. Held, steps behave as today, with the ghost and Tab.
- The sub-switch AUTO NEXT STEPS (today's NEXT STEPS) turns auto off everywhere. Off, it's today's behaviour.
- *My call:* an explicit `StepDone` instead of inferring "finished" from a turn ending. A turn that ends on a
  question in prose would otherwise start the next step over the user's answer.

## 4. Tickets: the TICKETS switch

Needs SKILL PATHS. Replaces today's TICKETS IN FRESH SESSIONS.

**Store.** `/to-tickets` writes files under `.mystical/tickets/<feature-slug>/` in the session's checkout (section 1).
Mystical keeps the set's state beside them in `set.json`: per ticket, its status, branch, worktree, session id and
base; per set, the parent session, the feature branch and merge progress. No DB change. *My call:* the files plus
`set.json`. The ticket text stays in Matt's format, readable by anyone.

**Approval.** `/to-tickets` itself quizzes the user and publishes only once the breakdown is approved, so files
appearing and its `StepDone` mean approved. Mystical then parses each file's "Blocked by" into a graph. A cycle,
or a blocker that doesn't exist, stops the set with a notice naming the problem, and nothing starts.

**Feature branch (both BUILD routes).** No automatic step ever builds on the default branch. When BUILD starts,
whether as tickets or as "BUILD here":
- If the flow session is already on a feature branch in a worktree, that branch is the feature branch.
- If it is on the default branch, Mystical creates `feat/<feature-slug>` from its HEAD in a new worktree.
  "BUILD here" then sends `/implement` naming that worktree as where to work, so the session moves there (as
  `work_cwd` already tracks).
- What the path wrote before BUILD (the grill's `GLOSSARY.md` / `docs/adr/*`, the spec) is uncommitted. Mystical
  commits **only the files this flow's turns wrote** (from the session's edit record, the FILES marks data) onto
  the feature branch as its first commit, so every ticket starts with those decisions. It never touches other
  sessions' edits, and never commits to the default branch. *My call.*

**Ticket sessions.**
- One worktree per ticket, on branch `tk/<feature-slug>-<NN>`, at the usual worktree root
  (`~/Projects/.worktrees/<repo>/tk-<slug>-<NN>`, via `git.worktree_add`).
- Base: no blockers means the feature branch's head. One blocker means its branch, once it's done.
  **Several blockers** means the first blocker's branch with the others merged in (`--no-ff`) when the worktree is
  made. A clash there becomes the ticket session's first job, and its prompt says so. *My call.*
- Its first prompt is `/mattpocock-skills:implement <absolute path of the ticket file>`, plus one line: this is ticket
  #NN of <set>, commit on this branch, call `StepDone` when it's done and green.
- At most **3** ticket sessions run at once per set. A finished ticket frees its slot, and the scheduler starts any
  ticket whose blockers are all done, lowest number first. A ticket waiting on an ask keeps its slot.
- **Done** = `StepDone` called and the branch has at least one commit past its base. A failed turn (not a usage
  limit, which already auto-resumes) marks the ticket FIX, frees the slot and holds its dependents. A tap retries
  it in the same worktree.
- Ticket sessions are ordinary sessions. They show in ATTENTION and Projects with `#NN` before the title, and their
  asks notify the same way as any session's on all surfaces.
- The scheduler lives in the bridge process and survives restarts by reading `set.json`, the same way waits and
  limit resumes already do.

**MERGE.** When every ticket is done, Mystical opens one **merge session** in the feature branch's checkout. Its
prompt lists the ticket branches in dependency order, and it merges them (`--no-ff`), resolves clashes, runs the
project's tests, commits and calls `StepDone`. The TICKETS tab counts merged branches (`git branch --merged`) for its
4 / 6. *My call:* one Claude session for the whole pass rather than a merge engine in Mystical plus a resolve
session per clash. It is less code, and Claude has to resolve the clashes and find the test command anyway. The
mockups' "a resolve session is on it" reads "the merge session is on it".

**With TICKETS off** (SKILL PATHS on), FEATURE and REFACTOR stop once `/to-tickets` has written the files. FLOW
shows BUILD as YOU, and the composer offers the first ticket in a fresh session, as today. *My call.*

**After.** RETRO runs in the flow session. The ticket worktrees stay. The set's ⋯ offers **Clean up worktrees**,
which asks first (the user's cleanup rule). The feature branch goes to `master` by the user's own merge routine.

## 5. FLOW tab (right rail, after Turns)

Drawn in `04-flow-tickets.html`, column 1.
- **Hero (132px):** the path map, one station per step. Done is a green ✓, the step now running has a pulsing ring,
  YOU marks a stop for the user, and ⚡ marks a step that starts by itself. The top line names the path and the
  step (FEATURE PATH · 2 OF 6), and the AUTO pill holds or releases auto for this session. The bottom line shows the
  running step and its time, plus time in flow.
- Under it come who picked the path and why, done steps folded to one line each, the running step as a card (its
  skills, what it's doing right now, its tool count) and the steps ahead with AUTO or YOU APPROVE. The bottom line
  shows context against the 150k smart zone.
- No path: an empty state that says so, with the rule or Claude's reason for none if there is one.
- Data: the session's path record (SetPath or rule), its turns' flow commands and `StepDone` events, and the ticket
  set for BUILD/MERGE. *Left to the builder:* where the per-session path record lives (a state JSON like
  `limit_resume.json`, or a sessions column).

## 6. TICKETS tab (left sidebar, between Projects and Plugins)

Drawn in `04-flow-tickets.html`, columns 2–3.
- A new sidebar `Mode`, `"tickets"`, with lucide `Ticket`. It shows only while TICKETS is on.
- One card per set: name, the session that made it, the feature branch and the 3 run slots, then the dependency
  graph (each ticket a small stub, lines from blockers, MERGE at the end).
- Then one **stub** per ticket: the perforated left part holds #NN and RUN / ASK / WAIT / DONE / FIX, and the body
  holds the title, branch and a live line (tools so far, the ask, what it waits for). Answer opens that ticket's
  ask, and anywhere else opens its session.
- The MERGE stub comes last: "after all N", then N / M as branches go in.
- A finished, merged set folds to one line. Sets from every project are listed, newest first.

## 7. Switches (AI tab)

| Switch | Change |
|---|---|
| SKILL ROUTER → **SKILL PATHS** | Same key (`router`), so the user's ON carries over. Now also loads the bundled pack, adds the paths pack and the tracker line to the system prompt, lists SetPath/StepDone and shows FLOW. Its cost line changes from "no extra call" to "~300 tokens in every run's system prompt". |
| AUTO PICKS | Unchanged. |
| NEXT STEPS → **AUTO NEXT STEPS** | On: steps start by themselves (section 3). Off: today's ghost. |
| SMART ZONE | Unchanged. |
| ASK MATT | **Removed.** Claude picking the path covers the case it was for. |
| SETUP NUDGE | **Removed.** Mystical provides the tracker. |
| TICKETS IN FRESH SESSIONS | **Replaced** by TICKETS. |
| **TICKETS** (new, under SKILL PATHS) | Ticket sessions, the scheduler, MERGE and the sidebar tab. Ships OFF, under a **new key** (the old `tickets` sub-switch defaults ON, so it can't be reused). |
| GRILL AS CARDS | Unchanged, separate. |

Existing defaults hold: new installs ship SKILL PATHS and TICKETS off. This machine already has the router on.

## 8. Rail refresh (its own slice, after or beside the above)

Drawn in `05-rail-refresh.html` and the Git crops `shots/g2-*.png`. Every right-rail tab opens with a **132px hero**,
the same height in every tab so switching never moves the list, in place of the shared `.gp-rd` readout. The lists
under the heroes don't change.

| Tab | Hero | Data it needs |
|---|---|---|
| Turns | The session on a clock: each turn a block where it ran, asks as dots above it, the running one breathing. The counts become one line. | Turns already loaded (started, duration, asks). |
| Files | This session's footprint: folders touched as a segmented bar with counts, and the last edited files (● being edited now). | The FILES marks data (`filesEdits`). |
| Git | **PIPE:** three stations (this Mac / branch / origin), each with an icon and a count. The station holding the work glows (amber when it's incoming), dotted arrows flow across the gaps still to cross, and **one button lies across the gap it closes** (Commit N / Publish N / Pull N). Synced shows NOTHING TO MOVE. The top line is a plain sentence plus fetch freshness ("checked 2m ago"). | The git status the panel already has; freshness from the auto-fetch (e2c91e27). |
| Branches | main as a trunk, with each worktree forking off it and the tip coloured by its state, plus a legend that counts them. | The BranchesPanel rows. |
| Rivendell | The linked project's board as one bar (todo, doing, review, done) and the next task with ▶. | Lane counts from the Rivendell connection (check the API has them; if not, the hero shows open/done only). |
| Team | The room: who's on now (green ring), who's away, and Send. | Presence the tab already reads. |
| Usage | The 5-hour window as a ring next to this week's days. | The get_usage meter (CLI signals release); the mock's 62% is illustrative. |
| FLOW | The path map (section 5). | |

Motion (the now-ring, live dots, flowing arrows and the breathing turn) stops under `prefers-reduced-motion`. The
mocks are in OSGILIATH (dark). Every hero must be checked in a light theme (PEBBLE) before it ships.

## Calls I made (check these)

1. Unlocked starts: the four skills in section 1. Everything that publishes, builds or hands off stays user-only and
   is started by Mystical.
2. `StepDone` as an explicit signal, not "the turn ended".
3. Several blockers: start from the first blocker's branch and merge the rest in at creation.
4. MERGE is one Claude session, not a merge engine plus a resolve session per clash.
5. Tickets live in the **session's** checkout (`.mystical/tickets/`), not always the main checkout. Removing that
   worktree before the set is merged loses them, which the cleanup offer guards against.
6. Ticket state is files plus `set.json`, not DB tables.
7. ASK MATT and SETUP NUDGE are removed.
8. `triage` and `wayfinder` are never started by Claude or by an automatic step; they run only when the user takes them.
9. Esc on a rule's pick sends "No path for this message." with the prompt.
10. No automatic step builds on the default branch. Both BUILD routes go through a `feat/<slug>` worktree, and
    Mystical commits only the flow's own uncommitted files there first.
11. With TICKETS off, a path stops after the ticket files are written.

## Left to the builder

- Folder name and layout of the vendored pack, plus how it's refreshed from upstream.
- Where the per-session path record lives, and the exact `set.json` shape.
- Parsing "Blocked by" (numbers or titles) and the wording of the cycle notice.
- Retry and clean-up UX details within the drawn stubs.
- How the rule set in route.py moves from `.scratch/<f>/issues/` to `.mystical/tickets/<f>/`.
- Whether unattended runs (Rivendell jobs, device runs) get the paths pack. Probably not, the way
  `_rivendell_note_for` keeps its note out of them.
- The order of slices: one sensible order is bundled pack → bench → SetPath/StepDone + auto steps → FLOW →
  tickets → TICKETS tab → rail refresh.

## How we'll know it works

- With SKILL PATHS on and the plugin uninstalled, the `/` list shows Matt's 27 commands, and a `/grill-with-docs`
  run works in a dashboard session, a bot session and a ticket session.
- The bench in section 2 passes.
- A FEATURE prompt in a scratch repo walks GRILL (cards) → SPEC (by itself) → TICKETS (approval) → BUILD (3 at once
  in worktrees, dependents after their blockers) → MERGE (one session, tests green) → RETRO, with only the grill
  answers and the ticket approval asked of the user.
- Restarting the bridge mid-BUILD resumes the set from `set.json` without starting a ticket twice.
- The suite (`python3 -m pytest tests/ -q`) and the dashboard checks stay green. New logic (path parsing, the
  scheduler, set state, StepDone handling) has tests.
- FLOW, TICKETS and every hero render as drawn, in a dark and a light theme, with no jump between tabs.

## Risks

- **Claude ignores the paths pack**, or starts paths on plain questions. The bench gates it, and the rules-only
  router stays as the fallback.
- **Cost:** about 300 constant tokens per run (cached), plus parallel ticket sessions that spend usage fast. 3 at
  once is the cap, and usage limits already park and auto-resume.
- **Plugin name clash** with the installed copy (section 1). Verify first.
- **Merge pain:** dependents carry their blockers' commits, so the final pass is mostly fast-forward-like. Clashes
  between independent tickets land in the merge session.
