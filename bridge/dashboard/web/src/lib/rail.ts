/* The right rail's own arrangement (/design-first right-rail-shell, 2026-11-05):
   the user's drag order laid over the app's, minus the tabs they hid, and the
   panel width they dragged. Pure, so rail.check.ts can pin it.

   A tab the stored order has never seen (LEARN switched on, a tab added in a
   later build) is not sent to the end: it follows its app-order predecessor,
   so it lands in its own group instead of trailing after USAGE. Hiding every
   tab is refused here as well as in the menu: a rail with nothing on it has
   no tile to right-click and bring them back. */

export const RIGHT_W = { min: 230, max: 520 } as const;

export function arrange<T extends { id: string }>(tabs: T[], order: string[], hidden: string[]): T[] {
  const out = tabs.filter((t) => order.includes(t.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  tabs.forEach((t, i) => {
    if (order.includes(t.id)) return;
    const prev = tabs.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, t);
  });
  const shown = out.filter((t) => !hidden.includes(t.id));
  return shown.length ? shown : out;
}

/** `ids` with the one at `from` moved to `to`, the others keeping their order. */
export function moveTo(ids: string[], from: number, to: number): string[] {
  const out = [...ids];
  const [it] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, it);
  return out;
}

/** A dragged panel width, in whole pixels inside the allowed range. */
export function clampRightW(px: number): number {
  return Math.round(Math.min(RIGHT_W.max, Math.max(RIGHT_W.min, px)));
}

/** The hide list with `id` flipped, for the menu's checklist. Hiding the last
 *  shown tab is refused, as in arrange(); ids no longer in `ids` drop out. */
export function toggleHidden(ids: string[], hidden: string[], id: string): string[] {
  const live = hidden.filter((h) => ids.includes(h));
  if (live.includes(id)) return live.filter((h) => h !== id);
  return ids.filter((t) => !live.includes(t)).length > 1 ? [...live, id] : live;
}

/** The tab the rail opens on at load: the one pinned with "Open here on
 *  start" while it still exists, else the one you left open. */
export function startTab<T extends string>(pinned: string, last: T, ids: readonly T[]): T {
  return ids.includes(pinned as T) ? (pinned as T) : last;
}
