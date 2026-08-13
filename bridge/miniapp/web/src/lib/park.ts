// Copy of the dashboard's src/lib/park.ts — same two-app duplication as the
// RunStream/Composer/stick trio. Read the original for why an element anchor is
// the only thing that survives a session switch: pixels don't, because every
// card remounts at its 60px contain-intrinsic-size guess.
export interface Park {
  /** id of the anchored element the view is parked in. */
  id: string;
  /** Its top against the scrollport's — negative once it's scrolled past. */
  offset: number;
  /** Child indices from that element down to what actually sits at the edge. A
   *  turn runs to hundreds of cards, so landing on the turn alone puts you a
   *  screen or two out once the cards inside it re-measure. */
  path: number[];
  /** That element's top against the scrollport's — used whenever the path still
   *  resolves, which is everything but a card that has changed shape since. */
  deep: number;
}

/** The first element that STARTS at or below the top edge, walking forward from
 *  whatever straddles it. A straddler is only as good as its own height, and a
 *  card that was skipped off-screen comes back a different size — align its top
 *  and everything under it slides by the difference, which is how a restore
 *  lands half a screen from where you were reading. What begins below the edge
 *  means the same thing in both layouts. Bounded: this runs on every scroll. */
function below(el: Element, from: Element, edge: number): Element | null {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
  walk.currentNode = from;
  for (let i = 0, n = walk.nextNode(); n && i < 64; n = walk.nextNode(), i++) {
    if ((n as Element).getBoundingClientRect().top >= edge) return n as Element;
  }
  return null;
}

/** Park on what the top edge is showing, held by its nearest anchored ancestor.
 *  Null when nothing there carries an id (an empty transcript, or a view whose
 *  rows aren't anchored) — there'd be nothing to come back to. */
export function parkAt(el: Element, anchor: Element | null): Park | null {
  if (!anchor) return null;
  const edge = el.getBoundingClientRect().top;
  const at = below(el, anchor, edge) ?? anchor;
  const node = at.closest("[id]");
  if (!node || node === el || !el.contains(node)) return null;
  const path: number[] = [];
  for (let n: Element = at; n !== node && n.parentElement; n = n.parentElement) {
    path.unshift([...n.parentElement.children].indexOf(n));
  }
  return {
    id: node.id,
    offset: node.getBoundingClientRect().top - edge,
    path,
    deep: at.getBoundingClientRect().top - edge,
  };
}

/** Put the view back on a park. Returns the pixels it actually moved, or null if
 *  the anchor isn't in the DOM yet — the transcript it belongs to hasn't
 *  rendered, so ask again when it has.
 *
 *  Call it again until it answers ~0. The first landing is measured against
 *  cards that were skipped off-screen and are only their size guess; landing
 *  renders them, and the measurement after that is the real one. */
export function restorePark(el: Element, park: Park): number | null {
  const node = document.getElementById(park.id);
  if (!node || !el.contains(node)) return null;
  const edge = el.getBoundingClientRect().top;
  let deep: Element | null = node;
  for (const i of park.path) deep = deep?.children[i] ?? null;
  // An unrendered box measures 0×0 — its top means nothing, so fall back to the
  // anchored element, whose own box is always laid out.
  const box = deep?.getBoundingClientRect();
  const before = el.scrollTop;
  el.scrollTop += box && (box.width || box.height)
    ? box.top - edge - park.deep
    : node.getBoundingClientRect().top - edge - park.offset;
  return el.scrollTop - before;   // clamped at the ends, so this can be less than asked
}
