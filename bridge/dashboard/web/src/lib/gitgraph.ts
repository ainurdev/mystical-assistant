import type { GitCommit } from "../api.ts";

/* Lane layout for the commit graph: `git log --all` order in, one lane per
   branch line out, plus the rails to draw in each commit's row band. */

export const ROW_H = 28;
export const LANE_COLORS = [
  "var(--acc)", "var(--purple)", "var(--warn)",
  "var(--info)", "var(--ok)", "var(--err)",
];
export const laneColor = (l: number) => LANE_COLORS[l % LANE_COLORS.length];

export interface Row {
  c: GitCommit;
  lane: number;
  /** rails inside this row's band; `a`/`b` are lane indices, y in pixels */
  edges: { a: number; b: number; y1: number; y2: number; color: string }[];
}

/** `lanes[i]` holds the sha lane i is currently waiting to draw. Commits arrive
 *  newest-first, so a lane is seeded by a child and consumed by its parent. */
export function layout(commits: GitCommit[]): { rows: Row[]; width: number } {
  const known = new Set(commits.map((c) => c.sha));
  let lanes: (string | null)[] = [];
  let width = 1;

  const rows = commits.map((c) => {
    const before = lanes.slice();
    let lane = lanes.indexOf(c.sha);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
    }
    // Every lane waiting on this sha lands here; the commit's own lane is
    // re-seeded with its first parent below, or freed if this is a root.
    lanes = lanes.map((s) => (s === c.sha ? null : s));
    lanes[lane] = null;

    const parents = c.parents.filter((p) => known.has(p));
    parents.forEach((p, n) => {
      if (lanes.indexOf(p) !== -1) return; // another lane already draws it
      if (n === 0) {
        lanes[lane] = p;
        return;
      }
      let free = lanes.indexOf(null);
      if (free === -1) free = lanes.length;
      lanes[free] = p;
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const after = lanes.slice();

    const mid = ROW_H / 2;
    const edges: Row["edges"] = [];
    before.forEach((s, i) => {
      if (s === null) return;
      if (s === c.sha) {
        edges.push({ a: i, b: lane, y1: 0, y2: mid, color: laneColor(i) });
        return;
      }
      const j = after.indexOf(s);
      if (j !== -1) edges.push({ a: i, b: j, y1: 0, y2: ROW_H, color: laneColor(i) });
    });
    parents.forEach((p) => {
      const j = after.indexOf(p);
      if (j !== -1) edges.push({ a: lane, b: j, y1: mid, y2: ROW_H, color: laneColor(j) });
    });

    width = Math.max(width, before.length, after.length, lane + 1);
    return { c, lane, edges };
  });

  return { rows, width };
}
