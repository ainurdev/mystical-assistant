---
name: design-first
description: Use when the user sends /design-first <task> or presses the composer's DESIGN button — design the change before any implementation. Produces brand-system HTML mockups plus a short spec, screenshots them into the transcript, and stops for approval; repo code changes start only after the user approves.
user-invocable: true
---

# Design first, implement after approval

The argument is a UI task. Do NOT implement it yet. This skill exists to put a
reviewable design in front of the user, in the transcript, before any repo
code changes.

## 1. Design

Load the repo's design-system skill (here: `mystical-assistant-design`) and
design with its tokens and components — no generic styling. Deliverables go in
`.mystical/design-drafts/<slug>/` (git-ignored runtime state):

- One **self-contained** HTML file per screen or state — inline CSS, no
  external fetches.
- `SPEC.md` — intent, components and tokens used, states, behavior notes,
  open questions. Short.

**With the experimental switch on, use the design view instead of steps 2 and 3.** Read
`design_context` (find_tools), then call `show_design`. When the direction is open, make three
rough directions as three pages on one board, say how they differ and ask which way to go. The
user opens PREVIEW DESIGN, points, draws, tweaks and remixes, and their comments come back as a
message naming the elements. Keep editing the page files: edits appear live. `inspect_ui` and
`critique_design` are there for checking it. Then ask for approval, and implement after it.

## 2. Show it in the transcript

Screenshot each mockup with the bridge-eyes skill and include the images in
your reply. The user reviews from a phone: the pictures are the review, the
HTML is the backup.

**Choices ride in the question, not loose in the transcript.** Directions to
pick between (A · TOKEN, B · HEADER…) don't get Attached one by one — that
pile is what made the user match file names to letters. The crops go in step 3's
question: each direction's crops in its option's `preview`, one markdown image
per state, `![In the box](/abs/path/a1.png)`. The card shows them on a stage
beside the options, tabbed by state. Attach only what isn't a choice: the one
design up for approval, a before shot.

## 3. Stop for approval

AskUserQuestion. Several directions: one option per direction (up to three),
lettered (`A · TOKEN`, the one you recommend first), its crops in `preview`,
plus **Park it**; revising is the card's own free-text answer. One design:
**Approve & implement** (its crops in that option's `preview`) / **Revise**
(they say what) / **Park it**. Do not touch repo code before an approve. On revise, loop back to
step 1. On approve, implement with the mockups and `SPEC.md` as source of
truth, normal workflow.
