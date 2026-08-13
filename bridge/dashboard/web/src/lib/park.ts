// Where a transcript is parked, in a form that survives a session switch.
//
// A scrollTop doesn't survive one. Switching unmounts every card, so they come
// back at the 60px `contain-intrinsic-size` guess rather than the real height
// the browser measured while you scrolled past them (median 117px) — the same
// number lands somewhere else entirely in the same transcript, further down the
// longer the trip up was. An element plus its offset from the top edge is read
// against the layout that's actually there, so it lands where you left off
// whatever the cards above it are currently guessing.
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
