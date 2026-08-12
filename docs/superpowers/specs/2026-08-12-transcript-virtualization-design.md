# Virtualizing the transcript

A 2608-event session takes 3.9 seconds to open on a phone and scrolls at 2.6
frames per second. This makes the cost of a long transcript independent of its
length.

## What it costs today

Measured against the live bridge on `127.0.0.1:8790`, headless Chrome 151, two
real sessions out of `~/.bridge_state/bridge.db`. The 4x column is
`Emulation.setCPUThrottlingRate: 4` — a stand-in for a mid-range phone.

|                     | 128 ev (median) | 2608 ev (worst) | 2608 ev @ 4x |
| ------------------- | --------------- | --------------- | ------------ |
| open -> DOM settled | 0.26 s          | 1.3 – 1.7 s     | **3.9 s**    |
| DOM nodes           | 5.4k            | ~52k            | ~49k         |
| JS heap             | 21 MB           | 69 – 81 MB      | 74 MB        |
| script time         | 84 ms           | 0.7 – 0.9 s     | **3.3 s**    |
| scroll frame p50    | 17 ms           | 17 – 32 ms      | **382 ms**   |
| frames over 50 ms   | 0 of 24         | 8–15 of ~90     | **65 of 77** |

The scroll figure comes from jumping `scrollTop` in 800px steps, which is
harsher than a real flick. It is the same test in every column, so the ratios
hold even though the absolute numbers are pessimistic.

Shape of the corpus: 496 sessions, median 110 events, p90 402, max 2608. The
worst session is 23 turns; its largest single turn is 335 events. **Only the top
few percent of sessions hurt** — but they hurt badly, and turn granularity is
coarse enough to fix them.

`/local/sessions/<id>` answers in 37 ms. The server is not the bottleneck. It
does ship **1.7 MB with no `Content-Encoding`**; that same body gzips to 377 KB.

## Why `content-visibility` isn't enough

Every event card already carries `content-visibility: auto` with
`contain-intrinsic-size: auto 60px` (`.vskip-card`, `miniapp/web/src/index.css:189`),
and `Transcript.tsx:150` records the decision not to virtualize on top of it.

That decision was right for what it optimized. But `content-visibility` *defers*
layout and paint rather than removing them — the work is paid the moment you
scroll somewhere. That is exactly why throttled scroll (382 ms/frame) is worse
than the throttled open (3.9 s). And it does nothing at all for the two costs
that dominate: React still mounts every card (~20 DOM nodes per event) and
react-markdown still parses every one.

## Targets

The measurements above are the acceptance criteria. After all three layers, for
the 2608-event session at 4x throttle:

- open -> settled under **1 s** (from 3.9 s)
- DOM nodes under **8k**, and flat in session length (from ~50k)
- JS heap under **30 MB** (from 74 MB)
- scroll frame p50 under **50 ms** (from 382 ms)
- first-paint payload under **100 KB** (from 1.7 MB)

The CDP probe that produced the table is kept and re-run before and after each
layer, at 1x and 4x, against these same two sessions.

## Layer 1 — gzip the response

`_json` gzips when the request's `Accept-Encoding` contains gzip and the body
exceeds 32 KB. Below that the compression costs more than the transfer saves.

The two ports are one process but two handler classes with two copies of the
helper — `bridge/dashboard/server.py:192` and `bridge/miniapp/server.py:199`. The
compression goes in a shared function both call, rather than being written
twice.

Verify: `curl -H 'Accept-Encoding: gzip'` against the big session returns
`Content-Encoding: gzip` and roughly 377 KB.

## Layer 2 — paginate by turn

`store.transcript(session_id, cursor)` (`bridge/store.py:870`) returns every turn
and every event at or after `cursor`. On first open `cursor` is 0, so the whole
session ships.

It gains a tail page: a `tail=<n_turns>` parameter returning only the last N
turns' events, plus a flag saying older turns exist and the seq to ask for them.

**The forward `cursor` path is the invariant.** Live polling (`App.tsx:522`,
every 1.5 s while running) depends on `cursor` meaning "events newer than this",
and `next_cursor` advancing monotonically. Tail paging is a separate, backwards
query; it must not perturb either.

Frontends request the tail on open and render a "load older" control above the
first loaded turn, which fetches the previous page and prepends it.

Verify: first paint of the big session transfers under 100 KB and mounts under
8k nodes.

## Layer 3 — virtualize the transcript

### The row list

Each session flattens into one array of rows, each tagged with its turn:

```
{ kind: 'prompt' | 'attachments' | 'runtime' | 'event' | 'working',
  turnId, ... }
```

Turns stop being a nesting level and become a property of a row. That flat array
is what `@tanstack/react-virtual` windows — already a dependency, already driving
the sessions list at `SessionsPanel.tsx:403`.

`AgentRail` (`Transcript.tsx:105`) currently draws one absolutely-positioned
hairline spanning a whole turn. A turn's rows are no longer mounted together, so
it becomes a per-row left border, with the diamond cap on the turn's first row.

### Row measurement

Rows are variable-height and a live turn's rows *grow* as text streams in. Each
mounted row registers with `measureElement`; the virtualizer's resize observation
handles the streaming case. This is the part most likely to produce bugs — a row
that reports a stale height leaves a visible gap or overlap.

### ctrl-F: overscan plus an escape hatch

Browser find only sees mounted rows. Two mechanisms together:

**A fixed overscan sized to the node budget.** Measured at ~20 DOM nodes per
event row, an 8k-node budget buys roughly 400 mounted rows in total. A phone
viewport holds on the order of 100 rows of this content, so the overscan is
about 150 either side. On the worst session that leaves ~15% of the transcript
resident at any time. The 150 is a starting point to be tuned against the probe,
not a derived constant.

**A Ctrl+F interceptor.** A keydown listener for Ctrl/Cmd+F sets the window to
the full list and `flushSync`es the render, then lets the event through; the
browser's find bar opens against a complete DOM. The window returns to normal
overscan when the find bar closes (approximated by blur/Escape, since find-bar
state is not observable).

Cost is one full mount per Ctrl+F — about 850 ms unthrottled on the worst
session — paid on an explicit gesture rather than on every open. ctrl-F is
desktop-only, so this is dashboard-only code.

### What breaks, and the fix

**The lightbox reparents.** react-virtual positions rows with
`transform: translateY`, and a transformed ancestor makes `position: fixed`
resolve against that ancestor instead of the viewport. Both lightboxes are
`fixed inset-0` rendered inline — `dashboard/web/src/components/ImageLightbox.tsx:18`
and `miniapp/web/src/components/ImageLightbox.tsx:17`. They would cover one row.
Fix: `createPortal` to `document.body`. Correct independent of virtualization,
and it removes the constraint `Transcript.tsx:158` currently documents.

**Checkpoint jumps miss.** `hud/Checkpoints.tsx:13,20` and
`miniapp/.../CheckpointsSheet.tsx:100` resolve a target with
`document.getElementById` and call `scrollIntoView`. An unmounted target fails
silently — no jump, no error. Fix: a `turnId -> rowIndex` map built alongside the
row list, and `virtualizer.scrollToIndex(i, { align: 'start' })`. `ckId` and
`marksOf` (`lib/checkpoints.ts`) are unchanged; only the jump changes.

**Hand-rolled scroll anchoring becomes harmful.** `App.tsx:546-608` corrects
scroll position against a viewport-tracked anchor node, and exists only because
`content-visibility`'s 60px guess makes content jump the first time it renders
at its true height (425px of drift measured on one trip up a 17k transcript).
The virtualizer's own measurement replaces it, and leaving both in place would
have them fight. It is deleted. Stick-to-bottom becomes
`scrollToIndex(rows.length - 1)`.

`lib/stick.ts` survives — `nearBottom` / `stickToBottom` encode *when* to follow
new content, which is still the right policy, and `stick.check.ts` keeps testing
it. Only the correction mechanism goes.

### Implemented: turn granularity (deviation, 2026-08-13)

Rows are **turns, not events**. Decided during planning: `mergeDelta` prepends
whole turns for free, RunStream's 1458 lines of folding/pending logic stay
untouched inside a row, and the cards' own `content-visibility` keeps
within-turn cost flat while a turn is mounted. The cost is a chunky mount when
a megaturn crosses the overscan edge (~200ms hitches at 4x, visible in scroll
p95); event-level rows via extracting RunStream's card pipeline remain the
escalation if that ever hurts. Heights are cached per turn id, so a size
estimate (~20px/event — chip folding compresses far below one card per event)
is wrong at most once. Ctrl-F synchronously mounts the full list before the
find bar opens; Escape re-windows.

Measured (2608-event session, dashboard, full 1.7MB payload — no tail):

|                    | before @4x | after @4x | target  |
| ------------------ | ---------- | --------- | ------- |
| open -> settled    | 3.9 s      | **0.9 s** | <1 s    |
| scroll p50         | 382 ms     | **30 ms** | <50 ms  |
| frames over 50 ms  | 65 of 77   | 39 of 152 | —       |
| transcript heap    | +57 MB     | **+5.5 MB** | (<30 absolute — met as delta; absolute is GC-noisy) |
| DOM nodes at rest  | ~49k       | 12–26k    | <8k missed when trailing megaturns sit in view; flat in session length, which was the point |

Median session @4x: settle 753 -> 522 ms, zero long frames. Scroll-up drift
after the anchoring handoff to `shouldAdjustScrollPositionOnItemSizeChange`:
0 px over 2.5 s parked 4000 px up.

Full stack (gzip + tail=3 + virtualizer, new Python on a throwaway 8795),
worst session @4x: **open 854 ms, scroll p50 16.9 ms, +4 MB heap, 53 KB
transferred** (from 3.9 s / 382 ms / +57 MB / 1.7 MB). The live bridge runs
the frontend half of this today; gzip and tail activate at its next restart.

## Order

Dashboard first, then the Mini App. The dashboard is what the CDP probe can
drive, so every layer stays verifiable at each step; the Mini App port follows
once the row-list shape is proven. Layers 1 and 2 are shared by both surfaces
already.

The phone is where this hurts most, which argues for the Mini App first — but
its numbers can only be checked by hand, and shipping an unverified rewrite of
the transcript renderer to the surface that matters most is the worse trade.

## Not doing

- **Event-level pagination.** The worst turn is 335 events, which mounts within
  the node budget on its own. Turn granularity is enough.
- **Backfilling anything.** No migration, no re-parse of stored transcripts.
- **Touching the runner's event vocabulary.** `text` / `thinking` / `tool` /
  `tool_done` stay exactly as they are; this is a rendering change.
