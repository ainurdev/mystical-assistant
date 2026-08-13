// Where you were reading, per session.
//
// Leaving a session used to throw that place away: coming back re-fetches the
// tail and follow-the-latest is armed by default, so you land at the bottom of
// a conversation you were halfway up. What we keep instead is an anchor — the
// turn at the top of the viewport and how far into it you'd scrolled.
//
// Not a raw scrollTop: the transcript is virtualized, so every row above you is
// an estimate until it mounts, and the same pixel lands on a different turn
// after a cold load. A turn id survives that; a number doesn't.

/** "bottom" = parked on the latest, which is also the default for a session we
 *  have never seen. */
export type Anchor = { turn: string; off: number } | "bottom";

/** Rendered rows in scroll coordinates — what a virtualizer's items already are
 *  (their `start` includes any scrollMargin, same frame as scrollTop). */
export type Rows = { key: string; start: number; end: number }[];

/** The anchor for a scroll position: the first row still on screen, plus how
 *  far into it. null when nothing is rendered — nothing worth remembering. */
export function anchorAt(rows: Rows, scrollTop: number): Anchor | null {
  const row = rows.find((r) => r.end > scrollTop);
  if (!row) return null;
  return { turn: row.key, off: Math.max(0, Math.round(scrollTop - row.start)) };
}

export type Store = Record<string, Anchor>;

const KEY = "hud-scroll-anchors";
const CAP = 40;                    // sessions remembered, oldest evicted

/** Newest last, oldest evicted past CAP — string keys iterate in insertion
 *  order, so the object *is* the recency list. */
export function put(store: Store, id: string, a: Anchor, cap = CAP): Store {
  const next: Store = {};
  for (const [k, v] of Object.entries(store)) if (k !== id) next[k] = v;
  next[id] = a;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete next[k];
  return next;
}

let cache: Store | null = null;
let flushT = 0;

function all(): Store {
  if (!cache) {
    try { cache = JSON.parse(localStorage.getItem(KEY) || "{}") as Store; }
    catch { cache = {}; }
  }
  return cache;
}

function flush() {
  flushT = 0;
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* quota / no storage */ }
}

/** Called on every scroll event, so the write is batched: the in-memory copy is
 *  what a session switch reads back, and localStorage (synchronous, on the same
 *  thread as the scroll you're doing) catches up a beat later. */
export function remember(id: string, a: Anchor) {
  cache = put(all(), id, a);
  if (!flushT) flushT = window.setTimeout(flush, 300);
}

export function recall(id: string): Anchor | undefined {
  return all()[id];
}
