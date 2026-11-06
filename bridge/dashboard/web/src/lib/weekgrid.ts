/* The USAGE tab's day x hour grid (hud/WeekGrid), free of React so
 * weekgrid.check.ts can run it under node. Rows are Monday..Sunday, local time. */

export interface GridCell { v: number; shade: number; future: boolean; now: boolean }

/** Cells for the report's `hours`; a missing report (older bridge) is an empty grid.
 *  Shade is (v/max)^0.6 so a quiet hour still shows next to a 25-turn one.
 *  Future and now only mean something for this week (back = 0). */
export function weekGrid(hours: number[][] | undefined, now: Date, back: number) {
  const max = Math.max(0, ...(hours ?? []).flat());
  const today = (now.getDay() + 6) % 7;
  const hr = now.getHours();
  let busiest = null as { day: number; hour: number; n: number } | null;
  const cells: GridCell[][] = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const v = hours?.[d]?.[h] ?? 0;
      if (v > 0 && (!busiest || v > busiest.n)) busiest = { day: d, hour: h, n: v };
      return {
        v,
        shade: v > 0 ? (v / max) ** 0.6 : 0,
        future: back === 0 && (d > today || (d === today && h > hr)),
        now: back === 0 && d === today && h === hr,
      };
    }));
  return { cells, busiest };
}
