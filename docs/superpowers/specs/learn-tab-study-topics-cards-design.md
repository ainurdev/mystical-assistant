# LEARN tab: graded study, topic shelves, concept cards

**Date:** 2026-08-24 · **Status:** approved (design), pending implementation plan

## Problem

Three weaknesses in the LEARN feature (`bridge/learn.py`, `LearnTab.tsx`, `lib/learn.ts`):

1. **Selection** — `nextUnread` picks the newest unread lesson; STUDY deals the same
   order; a revealed lesson is read forever and its **Check yourself** question never
   returns. No retention loop. Worse, the corpus is read *backwards*: the generator
   tells later lessons to refer back to earlier ones (`_PRIOR`), and newest-first
   dealing serves sequels before originals.
2. **Organization** — eleven fixed concept shelves, each a flat chronological list.
   Fine at 17 lessons, fails at ~28 per shelf. No layer between shelf and lesson, no
   relations, no progression.
3. **Content** — lessons lead with **What changed** (repo-specific) and bury
   **The idea** (the transferable part). Repeated encounters of the same pattern
   across repos never merge into a canonical explanation.

## Research: roadmap.sh concepts adopted

- A roadmap is a graph of **topic nodes**; each node has a small canonical **topic
  page** (markdown keyed to the node) separate from any specific project.
- Progress states richer than read/unread: **done / learning / skipped**.
- An **ordered path** through material, not a pile.
- Recall practice via **question banks** — our lessons already end with a quiz
  question the tab already asks first; only grading is missing.

Mapping: concept shelf ≈ roadmap; `> topic:` ≈ topic node; concept card ≈ topic
page; lesson ≈ project/instance; GOT IT / REVIEW / SKIP ≈ done / learning / skipped.

## Decisions

- **Gentle review model (user-chosen):** GOT IT on first read retires a lesson
  immediately. Only REVIEW AGAIN enters the ladder: due in 1d, then 3d, then 7d;
  GOT IT climbs, REVIEW resets to box 1, graduating past box 3 retires. STUDY never
  becomes homework; only flagged lessons return.
- **Review state stays in localStorage** beside the read set (dashboard-only, like
  everything else about reading). Server-side sync is deferred until the Mini App
  grows a LEARN surface.
- **Topics are free vocabulary with reuse pressure** (prior topics fed to the
  prompt), unlike the fixed CONCEPTS list — topics are domain-shaped and can't be
  enumerated upfront.
- **Cards are global, not per-repo** — concepts aren't repo-shaped (module
  docstring). Stored under `dirname(config.BRIDGE_DB)/learn-cards/`, so conftest's
  `BRIDGE_DB` pin isolates tests with no new env knob.
- Everything rides the existing `learn` AI feature flag and per-repo opt-out.

## Slice 1 — study upgrade + prompt fix

Frontend only, plus one prompt string.

**`lib/prefs.ts`** — add `useStickyObj<T>` (JSON object in localStorage, ~10 lines,
same shape as `useStickySet`).

**`lib/learn.ts`** — pure scheduling:

- Sticky map `hud-learn-sched`: `{ [lessonKey]: { box: 1|2|3, due: epochMs } }`.
  Entries exist only for lessons flagged REVIEW AGAIN.
- Transitions: REVIEW → `{box: 1, due: +1d}` (from any state). GOT IT on a
  scheduled lesson → box+1 (`due` +3d / +7d), past box 3 → delete entry (retired).
  GOT IT on an unscheduled lesson → no entry (retired; read set already marks seen).
  SKIP → mark read, delete any entry.
- `deal(list, read, sched, now)`: (1) scheduled lessons in scope with `due <= now`,
  oldest due first; (2) new unread, round-robin across concepts, oldest-first within
  each. Replaces `nextUnread` for STUDY; browse-mode auto-select keeps `nextUnread`.

**`LearnTab.tsx`**:

- Quiz card gains **SKIP** beside REVEAL.
- In STUDY, the post-reveal footer becomes a grade bar — **GOT IT / REVIEW AGAIN**
  — replacing NEXT; grading advances to the next dealt lesson.
- A due review re-asks its question in STUDY even though the lesson is read
  (gate = unread ∨ due-in-study). Browse mode unchanged: read lessons open directly,
  reading stays ungraded.
- STUDY header: `N DUE · M NEW`. Read meter and sidebar badge keep meaning
  unread-only — the feature must not nag.

**`bridge/learn.py`** — `_SYS` template flip:

- Title names the **pattern**, not the artifact (3–8 words, no repo jargon).
- New `> topic:` line (2–4 words, lowercase) directly under `> concept:`; prior
  lessons are listed with their topics and the model is told to reuse one when it
  fits. Written now so slice 2 lands on real data.
- Body order: **The idea** first (most words; name the standard pattern when one
  exists), **Seen here** (one or two sentences, real files), **Look at**,
  **Check yourself**.

## Slice 2 — topic layer

- **`bridge/learn.py`** — `_head()` parses the header block (title, `> concept:`,
  `> topic:`; stop at first non-empty non-header line — note the current
  break-after-concept loop must not eat the topic line). `lessons()` gains
  `"topic"`; `Lesson` in `api.ts` gains `topic: string`.
- **`lib/learn.ts`** — `shelves()` nests: `Shelf { concept, unread, lessons,
  groups: [{ topic, lessons, unread }] }` — `lessons` keeps the whole shelf for
  the shelf meter and search; `groups` is what the column renders, topicless
  lessons forming a trailing ungrouped group. Search still opens every shelf it
  hits.
- **`LearnTab.tsx`** — one more level in the shelf column with per-topic
  `done/total`; topics start shut like shelves.
- **Backfill** — one-shot CLI (`python3 -m bridge.learn --backfill <repo>`): for
  each lesson missing `> topic:` (or `> concept:`, e.g. lesson 0001), one haiku
  call proposes the lines, inserted under the title in place. Idempotent — tagged
  files are skipped. Run once per repo on the live machine after the slice ships.

## Slice 3 — concept cards

- **Trigger** — in `generate_after_turn`, after `_write`: count lessons sharing the
  new lesson's topic across `all_lessons()`. If ≥ 3 and the card is missing or
  older than the newest instance, run a background haiku one-shot that distills the
  instance lessons into one card. Overwrite in place; idempotent.
- **Storage** — `dirname(config.BRIDGE_DB)/learn-cards/<topic-slug>.md`.
  ponytail: the slug is the card's identity — two topics colliding on a slug share
  a card; key by exact topic string if that ever bites.
- **Format** — `# <pattern name>`, `> concept:`, `> topic:`, then **The pattern**,
  **When to reach for it**, **Trade-offs**, **Seen in** (per instance:
  project — lesson title (file)). No quiz section; cards are reference, not
  flashcards, and are not dealt in STUDY (v1).
- **API** — `/local/learn` response gains `cards` (ALL scope: all; repo scope:
  cards whose topic appears in that repo). `/local/learn?card=<slug>` returns a
  card body, slug matched against listdir like `read()`.
- **UI** — a topic group with a card pins a ◆ CARD row at its top; opens in the
  reader; read-tracked under key `card::<slug>`.

## Tests

- `tests/test_learn.py` — `_head` topic parsing (with and without the line, order
  variants); backfill inserts once and skips tagged files; card trigger writes at
  the threshold into the pinned state dir, not below it; regeneration overwrites;
  card read rejects names not on disk.
- `learn.check.ts` — sched transitions (REVIEW enters/resets, GOT IT climbs and
  retires, SKIP retires), deal order (due-first oldest-due, then round-robin
  concepts oldest-first), nested `shelves()` shapes, ungrouped tail last.

## Rollout

Build in a worktree (bridge-worktree). Slices land as separate commits in order —
each is shippable alone. Backend changes go live only on a bridge restart
(bridge-ship); run the backfill after slice 2 is live. The 17 existing lessons need
no migration for slice 1: absent from the sched map + present in the read set
already reads as retired.

## Deferred

- Full-ladder reviews for every lesson (user chose gentle mode).
- Cards dealt in STUDY / card quiz questions.
- Cross-device sched sync (server-side state).
- External resource links in lessons (pattern *names* only — URLs rot and
  hallucinate).
- The teaching-workspace extras (MISSION/RESOURCES/glossary) — existing ponytail
  note in `learn.py` keeps the bar: add when reading proves the habit sticks.
