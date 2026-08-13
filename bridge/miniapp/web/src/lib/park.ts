// Copy of the dashboard's src/lib/park.ts — same two-app duplication as the
// RunStream/Composer/stick trio. Read the original for why an element anchor is
// the only thing that survives a session switch: pixels don't, because every
// card remounts at its 60px contain-intrinsic-size guess.
export interface Park {
  /** id of the anchored element at the scrollport's top edge. */
  id: string;
  /** Its top against the scrollport's — negative once it's scrolled past. */
  offset: number;
}

/** Park on the nearest anchored ancestor of whatever sits at the top edge.
 *  Null when nothing there carries one (an empty transcript, or a view whose
 *  rows aren't anchored) — there'd be nothing to come back to. */
export function parkAt(el: Element, anchor: Element | null): Park | null {
  const node = anchor?.closest("[id]");
  if (!node || node === el || !el.contains(node)) return null;
  return { id: node.id, offset: node.getBoundingClientRect().top - el.getBoundingClientRect().top };
}

/** Put the view back on a park. False if its anchor isn't in the DOM yet — the
 *  transcript it belongs to hasn't rendered, so ask again when it has. */
export function restorePark(el: Element, park: Park): boolean {
  const node = document.getElementById(park.id);
  if (!node || !el.contains(node)) return false;
  el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - park.offset;
  return true;
}
