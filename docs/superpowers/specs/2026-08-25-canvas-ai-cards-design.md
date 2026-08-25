# AI cards on the canvas — design

2026-08-25 · drafted, awaiting approval

## Problem

A transcript is a queue: everything a model produces is buried by the next
message. That is fine for replies and fatal for anything meant to *stand* —
a plan you are working against, a lesson about what you just built, a warning
that the run has wandered, four design variants you are choosing between.

The bridge already spends model budget on exactly this class of output and then
hides it. `learn.py` writes one lesson per building turn into
`.mystical/learn/` — read only if you open the LEARN tab. `graphmap.py` knows
which subsystems a file belongs to — visible only in a modal. `design-first`
produces self-contained HTML mockups in `.mystical/design-drafts/<slug>/` and
then screenshots them into the scroll, which is the worst possible way to
compare four things: you compare from memory.

CANVAS (2026-08-25) added a gutter beside the conversation and, this session,
the ability to stand a right-sidebar panel in it. The gutter is the missing
place. This spec says what else goes there and where the content comes from.

## Decision: one card kind, five definitions

Everything below is the same feature — **a card the model keeps fresh** — so
it ships as one primitive with five registry entries, not five features. A
derived card is:

- **facts**, gathered deterministically (git, graphify, the session's own rows);
- **an optional one-shot model call** that turns those facts into ≤ 6 lines,
  through `runner.run_blocking` on a cheap model, the way `titler.py` and
  `flowtype.py` already do;
- **a watermark** — the cheapest string that changes when the answer would.
  Same watermark → served from cache → costs nothing, the posture `nextup.py`
  already takes with its per-repo cache key.

Two of the five cards spend nothing at all (the lesson is already written; the
live-files card is pure frontend). That is the point of one primitive: the
board does not care which cards cost money.

## 1. The primitive (`bridge/cards.py`, new)

```python
CARD = {
  "key": "drift",            # id, namespaced as card:drift on the wire
  "title": "DRIFT",
  "scope": "session",        # session | project
  "watermark": fn(ctx) -> str,   # "" = never cache
  "facts":     fn(ctx) -> dict,  # no model, no network beyond the repo
  "prompt":    str | None,       # None = the facts ARE the card
  "shape":     "lines" | "gallery",
}
```

`render(key, ctx)` = watermark → cache hit or `facts()` → optional
`run_blocking(prompt.format(facts=...))` → store. Cache is one JSON file beside
the DB (`cards.json`, keyed `<scope-id>:<key>`), same as `nextup.json`: this is
derived data, it must never make the DB a migration problem.

Failure is a card that says so. A model call that errors, times out or returns
an unparseable shape leaves the previous answer standing with a stale mark —
never a blank card, never a raised exception into the turn lifecycle
(`titler.py`'s guarantee).

## 2. Endpoints (`bridge/dashboard/server.py`)

- `GET /local/cards?session=<id>` / `?project=<rel>` → every enabled card for
  that scope: `{key, title, shape, body, generated, stale}`.
- `POST /local/cards/<key>/refresh` → force past the watermark. The card's own
  ◇ REFRESH; the only way a card costs money on a press.

Cards whose `aifeatures` switch is off are simply absent, exactly as the NEXT
tab is absent today.

## 3. Frontend (`Canvas.tsx`, `Terminal.tsx`)

The gutter already renders a list; it grows a second kind beside `PanelPin`:

- `canvasPins` entries become namespaced — `panel:changes`, `card:drift` —
  and the existing string array carries both. One migration line: a bare id
  loads as `panel:<id>`.
- `DerivedCard` renders through the existing `PinCard` frame (title, note,
  right slot). `note` carries `generated` as "3 turns ago", so a stale answer
  never reads as a live one.
- `PinPicker` lists cards under the panels, one chip each, dimmed with a
  tooltip when their AI switch is off.

Polling: cards refetch on turn end (the transcript already knows), not on a
timer. A card whose watermark has not moved returns its cached body — the
request is cheap, the answer is free.

## 4. The five cards

### 4a. `card:lesson` — zero model cost

`learn.py` has already written the lesson for the turn that just built
something. The card shows the newest one for this session, with the file path
as its note. **No new call.** The whole change is a read of what is already on
disk, put where it will be seen.

### 4b. `card:live-files` — zero model cost, no backend

One row per file the running turn has touched, with its diff-so-far, from
`toolfold.byFile` over the live run events the transcript already receives.
Pure frontend, no endpoint, no budget, no switch. This is the "what is it
actually doing" answer that a stream structurally cannot give: the stream
shows *events in order*, the card shows *state now*.

### 4c. `card:drift` — the cheapest useful call

- facts: the session's first prompt, the stage, and the subjects of the last N
  turns (titles the session already carries).
- watermark: `f"{turn_count // 5}"` — recomputed every fifth turn, not every
  turn.
- prompt: "What is this session doing now, versus what was asked? Two lines.
  Say ALIGNED if they match."

The failure mode this catches — a run that wandered thirty turns ago and reads
plausibly at every individual turn — is the one a transcript hides best.

### 4d. `card:impact` — facts from graphify, four lines from the model

- facts: files edited this turn (git status of the session's tree) plus their
  graphify neighbours and subsystems (`graphmap.py`, no LLM on the code path).
- watermark: sorted edited paths + head sha.
- prompt: "Which subsystems does this touch, and what else calls them? Four
  lines, no preamble."

### 4e. `card:design` — the gallery, and the reason for all of this

`design-first` writes `.mystical/design-drafts/<slug>/*.html`, each file
**self-contained with inline CSS and no external fetches** — which means the
dashboard can render them directly: read through the existing
`/local/files/read` and set `srcdoc` on an iframe. No screenshot pipeline, no
new file server, live mockups at real scale.

- `shape: "gallery"`: one iframe card per variant, laid out **across** the
  board rather than down the gutter — the one card that needs the board's
  width, and the only reason a gallery is not a list.
- Each variant carries a **judge** slot, filled on demand (one call per
  variant, never automatic): hierarchy, contrast, state coverage, scored
  against the repo's design-system skill as the rubric.
- A **PICK** action writes the choice into `SPEC.md` as `chosen: <file>`, which
  is what `/design-implement` and the Claude Design push already read.

Deterministic first: an off-token colour is found by scanning the HTML against
the design tokens, not by asking a model whether it looks right.

## 5. Budget and switches (`bridge/aifeatures.py`)

| card         | model call        | when                    | ships |
|--------------|-------------------|-------------------------|-------|
| lesson       | none (reuses learn)| —                      | ON    |
| live-files   | none              | —                       | ON    |
| drift        | 1 cheap           | every 5th turn end      | OFF   |
| impact       | 1 cheap           | turn end with edits     | OFF   |
| design judge | 1 cheap / variant | on press only           | OFF   |

Anything that fires without a press ships OFF, per `aifeatures.py`'s own rule.
The two free cards need no switch at all — they are a different rendering of
data the bridge already produced.

## 6. Degradation

- Model unreachable / limit reached → last answer stands, marked stale. Cards
  never queue a retry (`limits.py` parks turns, not cards).
- Graphify not built for a repo → impact card offers BUILD MAP, same as the MAP
  tab, instead of an empty frame.
- No drafts directory → the design card is absent, not empty.
- A card enabled while its watermark is unchanged → cached body, no spend.

## 7. Testing

- **pytest**: watermark hit/miss (a repeated render with the same watermark
  makes no model call — assert on a fake runner); cache file survives a
  malformed entry; each card's `facts()` against a temp repo; endpoint shape;
  a card whose switch is off is absent from the payload.
- **Frontend checks**: `cards.check.ts` beside the existing `lib/*.check.ts` —
  the `panel:` / `card:` namespace migration and the stale-label arithmetic.
- **bridge-eyes**: the gutter with a derived card, a stale card, and the
  design gallery at BOARD fit.

## 8. Rollout

Worktree per **bridge-worktree**. New persisted state is one JSON file beside
the DB, so nothing touches the live schema. Build order: primitive + endpoint →
the two free cards (lesson, live-files) → drift → impact → design gallery.
Dashboard only; the Mini App has no canvas and this spec does not give it one.
Live after a bridge restart per **bridge-ship**.

## Non-goals

- No new model provider, no streaming into a card — one-shot answers only.
- No arranging: cards stack in the gutter in pin order, like panels. Positions
  remain the `ponytail:` note in `Canvas.tsx`.
- No writing back into the session from a card (except the design PICK, which
  writes a file, not a turn).
- No cross-session cards; `nextup.py` already owns "across your repos".
- No Mini App parity.

## Open questions

1. **Drift cadence.** Every 5 turns is a guess. Every 10 halves the cost and
   catches drift later.
2. **Does the gallery belong in the gutter at all,** or is it a board mode of
   its own — the conversation column folded away, variants filling the width?
3. **Judge automatically on a new draft**, or strictly on press? Automatic is
   4 calls the moment `design-first` finishes, and it is the moment you most
   want the critique.
