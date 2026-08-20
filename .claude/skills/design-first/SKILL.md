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
user the repo isn't linked (dashboard ▸ ◇ DESIGN SYSTEM in the chat header, or
the project modal's DESIGN tab), design in-chat anyway,
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

## 4. Push the draft to Claude Design

DesignSync: `finalize_plan` with the projectId, `writes: ["drafts/<slug>/**"]`,
`localDir: <repo>/.mystical/design-drafts/<slug>` → `write_files` using
`localPath` per file, targeting `drafts/<slug>/...`. The user confirms the
plan card; afterwards the draft is viewable in the claude.ai design project.

## 5. Stop for approval

AskUserQuestion: **Approve & implement** / **Revise** (they say what) /
**Park it**. Do not touch repo code before an approve. On revise, loop back to
step 2. On approve, implement with the mockups and `SPEC.md` as source of
truth, normal workflow. After it ships, offer once to promote the draft into
the design system proper or delete `drafts/<slug>/` remotely — never do
either silently.
