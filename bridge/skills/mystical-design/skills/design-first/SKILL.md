---
name: design-first
description: Use when the user sends /design-first <task> or presses the composer's DESIGN button — design the change before any implementation. Produces brand-system HTML mockups plus a short spec, screenshots them into the transcript, pushes the draft to the linked Claude Design project, and stops for approval; repo code changes start only after the user approves.
user-invocable: true
---

# Design first, implement after approval

The argument is a UI task. Do NOT implement it yet. This skill exists to put a
reviewable design in front of the user — in the transcript and in their
claude.ai design pane — before any repo code changes.

## 1. Find the linked design project

Read `~/.bridge_state/project_config.json`. The key is the repo's trailing
path (this repo: `/mystical-assistant`), with an optional `@<branch>` variant
that wins over the plain key; the field is `design_project`. No key → tell the
user the repo isn't linked (dashboard ▸ the chat header's project name ▸ ◇ Design system, or
SETTINGS ▸ Projects ▸ Design system), design in-chat anyway,
and skip step 4.

## 2. Design

Load the repo's design-system skill (here: `mystical-assistant-design`) and
design with its tokens and components — no generic styling. Deliverables go in
`.mystical/design-drafts/<slug>/` (git-ignored runtime state):

- One **self-contained** HTML file per screen or state — inline CSS, no
  external fetches, first line `<!-- @dsCard group="Drafts" -->` so claude.ai
  renders it as a preview card.
- `SPEC.md` — intent, components and tokens used, states, behavior notes,
  open questions. Short.

## 3. Show it in the transcript

Screenshot each mockup with the bridge-eyes skill and include the images in
your reply. The user reviews from a phone: the pictures are the review, the
HTML is the backup.

**One crop per state, at 2x, never the whole sheet.** A sheet with three states
and a notes column reaches a phone at a fifth of life size and reads as "low
resolution" (2026-10-15, prompt-box). Capture each state's column on its own
(`.mystical/probe-mac/shots.mjs <url> <prefix> .col` does every `.col` at 2x;
on Linux use CLIP= with shot2.mjs) and Attach those; the Attach result now
names the size and says when a picture is a poster or a 1x capture.

**Choices ride in the question, not loose in the transcript.** Directions to
pick between (A · TOKEN, B · HEADER…) don't get Attached one by one — that
pile is what made the user match file names to letters. The crops go in step 5's
question: each direction's crops in its option's `preview`, one markdown image
per state, `![In the box](/abs/path/a1.png)`. The card shows them on a stage
beside the options, tabbed by state. Attach only what isn't a choice: the one
design up for approval, a before shot.

## 4. Push the draft to Claude Design

DesignSync: `finalize_plan` with the projectId, `writes: ["drafts/<slug>/**"]`,
`localDir: <repo>/.mystical/design-drafts/<slug>` → `write_files` using
`localPath` per file, targeting `drafts/<slug>/...`. The user confirms the
plan card; afterwards the draft is viewable in the claude.ai design project.

## 5. Stop for approval

AskUserQuestion. Several directions: one option per direction (up to three),
lettered (`A · TOKEN`, the one you recommend first), its crops in `preview`,
plus **Park it**; revising is the card's own free-text answer. One design:
**Approve & implement** (its crops in that option's `preview`) / **Revise**
(they say what) / **Park it**. Do not touch repo code before an approve. On revise, loop back to
step 2. On approve, implement with the mockups and `SPEC.md` as source of
truth, normal workflow. After it ships, offer once to promote the draft into
the design system proper or delete `drafts/<slug>/` remotely — never do
either silently.

Whatever they pick (a direction, a revise that settles it, Park it), record it
with `mcp__mystical-ux__RecordUx`: the pattern's slug, its verdict,
`status: decided` once picked, the Mobbin screens you used, and a `case` saying
which option they took and whether it was the one you recommended. Before
step 2, `SearchUx` the question: a decided pattern is where the design starts.
