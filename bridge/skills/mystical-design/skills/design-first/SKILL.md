---
name: design-first
description: Use when the user sends /mystical-design:design-first <task> or presses the composer's DESIGN button — design the change before any implementation. Drafts three Directions as HTML mockups on one design board, checks each one (axe, the judgement pass, an independent critic), screenshots them into one approval card, pushes the draft to the linked Claude Design project, and stops for a pick; repo code changes start only after the user approves.
user-invocable: true
---

# Design first, implement after approval

The argument is a UI task. Do NOT implement it yet. This skill puts three checked
Directions in front of the user, in one card and in their claude.ai design pane, before
any repo code changes.

Walk the steps in order. Where a step loads a skill, load it by the name given, with
the Skill tool. Never wait for a skill's own description to trigger it.

## 1. Find the linked design project

Read `~/.bridge_state/project_config.json`. The key is the repo's trailing path (this
repo: `/mystical-assistant`), with an optional `@<branch>` variant that wins over the
plain key; the field is `design_project`. No key → tell the user the repo isn't linked
(dashboard ▸ the chat header's project name ▸ ◇ Design system, or SETTINGS ▸ Projects ▸
Design system), design in-chat anyway, and skip step 9.

## 2. SearchUx the question

`mcp__mystical-ux__SearchUx` the question. A decided pattern is where the design
starts: build on it, and don't argue it again.

## 3. design_context

Read `design_context` (find_tools). When the repo has no `DESIGN.md`, load
/mystical-design:create-design-md and write one in repository mode, a source cited for
every value, and run its lint. Don't commit it: the design run never commits. It is one
of the flow's files, so it reaches the feature branch with the build.

## 4. Load the skills for the repo

- The repo's own design-system skill, when it has one (this repo:
  `mystical-assistant-design`). Its fonts, colours and components win.
- In a web repo, /mystical-design:frontend-design for craft. Its fonts and colours apply
  only where the repo has none.
- In an Expo repo (`expo` in package.json), /mystical-design:expo-native-ui and
  /mystical-design:expo-design-system.

## 5. Concepts

List about eight one-line concepts. Keep the three most different: different layout,
type and colour decisions, not one layout in three colours.

- One Direction stays in place: the smallest change to what is there now.
- At most one is an **Off-system direction**: it leaves the repo's design system on
  purpose. It goes in the third slot, labelled OFF-SYSTEM, with its reason in one line.

Name each Direction with a letter and a token: `A · TOKEN`, `B · HEADER`, `C · RAIL`.

## 6. Draft each Direction

Deliverables go in `.mystical/design-drafts/<slug>/` (git-ignored runtime state):

- One **self-contained** HTML page per state of each Direction: inline CSS, no external
  fetches, first line `<!-- @dsCard group="Drafts" -->` so claude.ai renders it as a
  preview card. Draw the empty, loading and error states too, where the screen has them.
- `SPEC.md`: intent, then per Direction its idea, components and tokens used, states,
  behaviour notes and open questions. Short.

Put the Directions up as pages of one **Design board**: `show_design` with every page.
The user opens PREVIEW DESIGN, points, draws and comments, and their comments come
back as a message naming the elements. Keep editing the page files: edits appear live.

## 7. The Self-check

For each Direction, before the card:

1. **Measured checks.** `inspect_ui` on each of its pages, at phone and desktop width
   (the default). axe runs inside it. Fix every axe violation, or name it with the reason
   it stays. A clean axe run means axe found nothing. It does not mean the page is
   accessible: never say so.
2. **The judgement pass.** Read this pack's `references/judgement-pass.md`
   (`../../references/judgement-pass.md` from this skill's folder) and go through its
   three parts for every state.
3. **The critic, once.** `critique_design` on the Direction's page with `fresh: true`.
   For the OFF-SYSTEM Direction add `bold: true`. If it answers that it is still running,
   call it again until the answer arrives: that is still the one run. Treat it as a
   defect finder. Check each problem against the page yourself, then fix the real P0
   and P1 problems, and P2 problems where the fix is cheap. Don't call the critic again
   after your fixes.
4. **Fix rounds.** After each fix round, run the measured checks (1) again. Stop after
   two fix rounds, whatever is left.

Record each Direction's checks in SPEC.md, under a `Self-check` heading: what each check
found, what you fixed, and what is left with its reason. When the critic didn't run
(off, failed or unavailable), write that, and say so on the card too.

The critic's problems never rank the Directions. Recommend a Direction for how well it
does the job, not for how few problems the critic listed.

## 8. Crops

Screenshot each state with the bridge-eyes skill. The user reviews from a phone: the
pictures are the review, the HTML is the backup.

**One crop per state, at 2x, never the whole sheet.** A sheet with three states and a
notes column reaches a phone at a fifth of life size and reads as "low resolution".
Capture each state's column on its own (`.mystical/probe-mac/shots.mjs <url> <prefix>
.col` does every `.col` at 2x; on Linux use CLIP= with shot2.mjs). The Attach result
names the size and says when a picture is a poster or a 1x capture.

Don't Attach the Directions' crops one by one: they go in the card (step 10).

## 9. Push the draft to Claude Design

DesignSync: `finalize_plan` with the projectId, `writes: ["drafts/<slug>/**"]`,
`localDir: <repo>/.mystical/design-drafts/<slug>` → `write_files` using `localPath` per
file, targeting `drafts/<slug>/...`. The user confirms the plan card; afterwards the
draft is viewable in the claude.ai design project.

## 10. The card

One AskUserQuestion. The question line names the task.

- One option per Direction, lettered (`A · TOKEN`), the one you recommend first, with
  "(Recommended)" on its label.
- Each option's `preview` holds its crops, one markdown image per state:
  `![In the box](/abs/path/a1.png)`. The card shows them on a stage beside the options,
  tabbed by state.
- Each option's description gives its idea in one line, then its Self-check: what was
  checked, what was fixed, what is left. For example: "Checked: axe at 390 and 1280,
  judgement pass, critic. Fixed: 2 contrast, empty state. Left: P2 dense header
  (kept for the row height)." When the critic didn't run, say "critic off".
- **Park it**, as the last option.
- Revising is the card's own free-text answer: on a revise, go back to step 5 or 6 as
  the answer needs.

Do not touch repo code before a pick.

## 11. On a pick

- **SPEC.md** records the approved Direction at the top, plus a `Build` section naming
  the skills the build loads:
  - /mystical-design:shadcn where the repo is built on its components (`components.json`, or
    `@/components/ui` imports);
  - /mystical-design:expo-animation for motion in an Expo app;
  - the repo's own design-system skill.
- **RecordUx** (`mcp__mystical-ux__RecordUx`) whatever they picked (a Direction, a
  revise that settles it, Park it): the pattern's slug, its verdict, `status: decided`
  once picked, the Mobbin screens you used, and a `case` saying which option they took
  and whether it was the one you recommended.
- **In a flow's design step** (the prompt says so), call StepDone: the build step builds.
- **Outside a flow,** build with the mockups and SPEC.md as the source of truth, then run
  /mystical-design:polish. After it ships, offer once to promote the draft into the
  design system proper or delete `drafts/<slug>/` remotely. Never do either silently.
