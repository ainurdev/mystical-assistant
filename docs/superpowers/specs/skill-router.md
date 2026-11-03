# Skill router: Matt Pocock's flows, picked for you

Mockups (git-ignored, on this Mac): `.mystical/design-drafts/skill-router/`, picked direction `06-c-ghost.html` (crops `shots/c2-1..4.png`). Bench: `.mystical/skill-bench/bench.py`.

## Decided 2026-11-04
Picked in order: behaviour first, then the look. Final picks: **C · GHOST**, **both packs on**, **plan before building**.
- **How it picks:** rules from Matt's map (below), free and instant. When nothing fits a prompt over ~200 chars,
  it offers **Ask Matt**, which sends `/mattpocock-skills:ask-matt <prompt>` as a normal turn.
- **When:** every composer prompt that doesn't already start with `/`, after a ~400 ms typing pause, and a next step
  when a turn whose prompt carried a flow command ends. Steers into a running turn are never routed.
- **Add-ons, all four:** smart-zone mark + `/compact <next phase>` at a boundary past 150k; implement the first
  unblocked ticket in a fresh session; setup nudge; auto for safe picks.
- **Auto, scoped:** safe picks (`grill-with-docs`, `diagnosing-bugs`, `research`, `prototype`, `tdd`) go in front by themselves,
  and Backspace removes them before Send. They do this only on a session's first prompt, or right after a flow step ended.
  A follow-up inside a running flow only gets a suggestion. Commands that publish or hand off are always a tap.
- **Two packs, measured** (`.mystical/skill-bench/`: 12 throwaway Opus 5.5 runs, 1 per cell, 6 turns max, writes and shell blocked,
  the bridge's system prompt on, user hooks off). This is a signal, not proof:

  | Prompt | superpowers + Matt | Matt only |
  |---|---|---|
  | `/grill-with-docs …` (routed) | grilling + domain-modeling | same |
  | `/implement …` (routed) | Matt's `tdd` at step 9 | none within 6 turns |
  | `/diagnosing-bugs …` (routed) | nothing stacked on top | nothing stacked |
  | bug report, unrouted | `superpowers:systematic-debugging` | **none** (diagnosing-bugs never fired) |
  | new feature, unrouted | **none** (brainstorming didn't fire) | none |
  | "review the last commit" | `ponytail:ponytail-review` | same |
  | cost, 6 prompts | $2.27 | $2.01 |

  Superpowers never doubled a routed command. Unrouted, Matt's skills fired 0 of 3 times, so the router is what makes the pack work.
  Superpowers catches some of what the router leaves alone. The "Matt leads" run-time line isn't needed.
- **Every piece can be switched off** (asked 2026-11-04, "not just ask matt, also tickets and the other new features"): SKILL ROUTER in the AI tab,
  with sub-switches shown under it while it's on: ASK MATT, AUTO PICKS, NEXT STEPS, TICKETS IN FRESH SESSIONS, SMART ZONE, SETUP NUDGE.
  GRILL AS CARDS is its own switch, because it shapes any grilling run, routed or typed. Keys, env flags and defaults are in the plan's Global Constraints.
- **Names, verified:** with the plugin loaded, the CLI lists only `mattpocock-skills:<name>`. There is no bare `/grill-with-docs`,
  so the router sends the namespaced name.

## Why this exists
`mattpocock/skills` (at 4ae2317, 2026-10-31) splits its skills by who can start them.

- **User-invoked** (16, `disable-model-invocation: true`): `ask-matt`, `grill-with-docs`, `grill-me`,
  `to-spec`, `to-tickets`, `implement`, `implement-spec`, `triage`, `wayfinder`, `retro`,
  `improve-codebase-architecture`, `setup-matt-pocock-skills`, `handoff`, `teach`, `to-questionnaire`, `wait-what`.
  Claude can never pick these. They run only when the prompt **starts with** `/name`.
- **Model-invoked** (11): `tdd`, `diagnosing-bugs`, `prototype`, `research`, `code-review`, `pr`,
  `codebase-design`, `domain-modeling`, `grilling`, `wizard`, `writing-for-agents`. Claude already reaches for these by description.

`/ask-matt` is Matt's own router, but it is user-invoked too, and it only advises: you still type the next
command yourself. Mystical sees every prompt before Claude does, so it is the one place that can put the
right `/command` in front. The router below follows `ask-matt`'s map.

## Matt's map (from ask-matt/SKILL.md + PHASE-BOUNDARIES.md)
- Main flow: `grill-with-docs` → (`prototype` detour) → multi-session? `to-spec` → `to-tickets` → `implement`
  per ticket in a fresh context, or `implement-spec` for all of them : else `implement` here → `retro`.
  `implement` drives `tdd` and ends with `code-review`.
- On-ramps: `triage` (issues you didn't write), `diagnosing-bugs` (something broken), `wayfinder` (too big for one session).
- Context: keep grill → spec → tickets in one window. Smart zone is about 150k tokens; past it, `/compact <next phase>` at a phase boundary, never mid-phase.
- Precondition: `/setup-matt-pocock-skills` once per repo. It writes `docs/agents/issue-tracker.md`,
  `docs/agents/domain.md` and an `## Agent skills` block in CLAUDE.md. Detect setup with the first file.

## Install
`claude plugin install mattpocock-skills@claude-plugins-official`. It is already in the local marketplace and updates itself.
`bridge/commands.py` then lists the skills as `mattpocock-skills:<name>`, and the segment draws the namespace part dim.
Unverified: whether the CLI also resolves the bare `/grill-with-docs` for a plugin skill. The router sends whichever name the `/` list has.

## The router (shared by A, B and C)
Inputs: prompt text; session (fresh?, which flow commands its plates carry, last turn's outcome);
repo (setup file, GLOSSARY.md, uncommitted diff, open PR); context tokens.
Output: `{command, why, step, alternates[≤3]}`, or nothing.

First match wins. Only commands in the project's `/` list are offered, so a pack that isn't installed is never suggested.

| Signal | Route | Alternates |
|---|---|---|
| prompt already starts with `/` | none | |
| repo has no `docs/agents/issue-tracker.md` and an engineering route matched | `setup-matt-pocock-skills` (once) | the matched route |
| error text / stack trace / "broken, fails, crash, regression, slow" | `diagnosing-bugs` | `tdd` |
| "review, check my changes" + a diff | `code-review` | |
| "triage, issues, bug reports" | `triage` | |
| huge or foggy ("rewrite, new app, migrate everything") | `wayfinder` | `grill-with-docs` |
| new feature or idea ("add, build, I want, should we, how can we") | `grill-with-docs` | `prototype`, `implement`, `grill-me` |
| "spec, write it up" after a grill in this session | `to-spec` | `implement` |
| "tickets, split, break down" | `to-tickets` | |
| "test-first, red-green" | `tdd` | |
| "research, find out, docs for" | `research` | |
| "architecture, refactor, tangled" | `improve-codebase-architecture` | |
| "teach me" / "what? I don't get it" | `teach` / `wait-what` | |
| nothing matched, prompt over ~200 chars | Ask Matt in ▾ only | |

Next step after a turn, from the flow command its plate carried: grill → `to-spec` (or `implement` here);
to-spec → `to-tickets`; to-tickets → `implement` ticket #1 (no blockers); implement → `retro`; diagnosing-bugs → `retro`.

A and B need no model call. C makes one haiku one-shot per long prompt, the way `bridge/relevance.py` does (about 36k tokens and 8–15 s).

## Directions (round 1, before the behaviour was decided; C is ruled out because routing is by rules)
- **A · ROUTE PILL** (in place, recommended). The pick sits in the composer's pill strip as a dashed `route` pill
  while you type (after a ~400 ms pause). Tab or a tap puts `/<name> ` in front, drawn as the existing CmdSeg segment.
  Esc or ignoring it sends the prompt as typed. ▾ shows the alternates, **Ask Matt** (sends `/ask-matt <prompt>`, one turn)
  and **Send as typed**. After a turn ends, the same pill shows `next` with flow dots and the next command.
- **B · FLOW TRACK** (new band). A track at the top of the prompt box: GRILL · SPEC · TICKETS · BUILD · RETRO.
  The routed station lights up, and mid-flow it shows progress and the next free ticket with **Implement in a fresh session**.
- **C · HOLD CARD** (model decides on send). The prompt is held on a card in the transcript: "Start with /x", why,
  **Run /x** · **Send as typed** · **Other route ▾**. It is more accurate on vague prompts, and every routed prompt waits and pays for it.

Tokens and components: OSGILIATH palette (sampled 2026-11-03), `.pillstrip`/`.pill` (as Goal),
`.cmdseg` segment, `.btn`, the goal sheet's popover chrome (`--pop-shadow`, `#141518`). Nothing new in the design system.

## Directions, round 2 (drawn on the decided behaviour; files 04–06)
Each one is drawn in four states: Auto (a session's first prompt), Unsure (Ask Matt), Past the zone (compact first), Tickets (fresh session).
- **A · PILL**: the pick and its reason sit in the pill strip. An auto pick is already in the text, and the pill says why, with ⌫ DROP and ▾.
- **B · TRACK**: a flow band at the top of the box, with an AUTO tag, a COMPACT stop past 150k, and the next free ticket.
- **C · GHOST** (recommended): no new row. The command sits in the text where it will be sent, solid when it was auto-applied
  and dashed when Tab would take it, with one faint line under the text saying why. Clicking the segment opens the other fits.

## Behaviour notes (all directions)
- **Grilling on a phone.** `ASK_SYSTEM_PROMPT` says "One decision, not an interrogation", which fights `grilling`'s rounds.
  Every run's system prompt gets one **constant** line (a per-turn line would bust the prompt cache, runner.py:215-231): when a
  grilling skill runs, ask each round as **one** AskUserQuestion card, up to 4 questions, recommended answer first, worded so yes takes it.
- **Two packs: both on.** Measured: routed commands were never doubled by superpowers, so no "follow /<cmd>" line.
- **Attachments.** A prompt with files gets an attachment note prepended (runner `_with_images`), which pushes a leading `/command`
  off the start and the CLI would not run it. The note goes after the command name instead.
- Never auto-applied, only suggested: commands that publish or hand off (`to-spec`, `to-tickets`, `triage`, `implement-spec`, `wayfinder`, `handoff`).
- An AI tab switch, **SKILL ROUTER**, with the cost line "no extra call" (A/B) or "1 haiku call per long prompt" (C).
- Surfaces: dashboard first (99% of turns). Bot and Mini App get the system-prompt lines only.

## Add-ons (offered separately)
1. A smart-zone mark at 150k on the context tab. Past it, at a phase boundary, the pill offers `/compact <next phase>`.
2. After `to-tickets`, open the first ticket with no blockers in a fresh session with `/implement <ticket>`.
3. Setup nudge: the first engineering route in a repo without setup is `/setup-matt-pocock-skills`.
4. AUTO for safe picks: grill, diagnose, research and prototype go in front by themselves, still removable.

## Open questions
- Which pack owns debugging, TDD, planning and review: Matt's alone, or both packs on?
- The tracker for `/setup-matt-pocock-skills` in this repo: local `.scratch/` files, GitHub, or Rivendell (it takes "anything else you describe").
- Bare `/name` vs `mattpocock-skills:name`: check once the plugin is installed.
