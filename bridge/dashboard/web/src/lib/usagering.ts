/* The Usage hero's arithmetic (hud/UsageRing), free of React so
 * usagering.check.ts can run it under node. */

export const RING_R = 25;
export const RING_C = 2 * Math.PI * RING_R;

/** Stroke length of the ring's arc for a percent; 0 for an unknown figure. */
export const ringDash = (p: number | null) => (p === null ? 0 : (Math.min(100, Math.max(0, p)) / 100) * RING_C);

export const ringText = (p: number | null) => (p === null ? "—" : `${p}%`);

/** Bar heights scaled to the week's max; a day with nothing is still a 2px stub. */
export function barHeights(vals: number[], max: number): number[] {
  const peak = Math.max(...vals, 0);
  return vals.map((v) => (peak > 0 && v > 0 ? Math.max(2, Math.round((v / peak) * max)) : 2));
}

/** Index (0 = first day) of `today` in the week starting `first`, both YYYY-MM-DD; -1 outside it. */
export function todayIndex(today: string, first: string): number {
  const n = Math.round((Date.parse(today) - Date.parse(first)) / 86400000);
  return n >= 0 && n < 7 ? n : -1;
}

/** The hero's caption: a day's turns, or the week's turns and sessions. */
export const capText = (turns: number, sessions?: number) =>
  `${turns} ${turns === 1 ? "turn" : "turns"}${sessions === undefined ? "" : ` · ${sessions} ${sessions === 1 ? "session" : "sessions"}`}`;

/** The ring's window: the 5-hour one only (never the week's, which the composer chip falls back to),
 *  and none once its reset time has passed, since its figure is stale. */
export function ringWindow<T extends { tag: string; resets_at: string | null }>(ws: T[], nowMs: number): T | null {
  const w = ws.find((x) => x.tag === "5H");
  return w && !(w.resets_at && Date.parse(w.resets_at) <= nowMs) ? w : null;
}
