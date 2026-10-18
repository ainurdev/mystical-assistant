import type { GitCommit } from "../api.ts";

/* Lane layout for the commit graph: `git log --all` order in, one lane per
   branch line out, plus the rails to draw in each commit's row band. Rows are
   not all one height — a row carrying refs grows a second line for its chips —
   so an edge names which part of the band it spans and the renderer resolves
   the pixels: `in` runs from the row's top down to its dot, `out` from the dot
   to the bottom, `thru` top to bottom past a dot that isn't on its lane. */

export const ROW_H = 28;
/** Where the dot sits in every row: the middle of the first (subject) line. */
export const DOT_Y = ROW_H / 2;
export const LANE_COLORS = [
  "var(--acc)", "var(--purple)", "var(--warn)",
  "var(--info)", "var(--ok)", "var(--err)",
];
export const laneColor = (l: number) => LANE_COLORS[l % LANE_COLORS.length];

export type Seg = "in" | "thru" | "out";
export interface Row {
  c: GitCommit;
  lane: number;
  /** rails inside this row's band; `a`/`b` are lane indices */
  edges: { a: number; b: number; seg: Seg; color: string }[];
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

    const edges: Row["edges"] = [];
    before.forEach((s, i) => {
      if (s === null) return;
      if (s === c.sha) {
        edges.push({ a: i, b: lane, seg: "in", color: laneColor(i) });
        return;
      }
      const j = after.indexOf(s);
      if (j !== -1) edges.push({ a: i, b: j, seg: "thru", color: laneColor(i) });
    });
    parents.forEach((p) => {
      const j = after.indexOf(p);
      if (j !== -1) edges.push({ a: lane, b: j, seg: "out", color: laneColor(j) });
    });

    width = Math.max(width, before.length, after.length, lane + 1);
    return { c, lane, edges };
  });

  return { rows, width };
}

/** The commits a push would send — reachable from HEAD and not from the
 *  upstream's commit, `git log @{u}..HEAD` over the loaded log. A first-parent
 *  walk is not enough: master is often fast-forwarded onto a branch that
 *  merged origin/master in as a second parent, and that line never meets the
 *  upstream's row. Empty when HEAD or the upstream's row isn't loaded (the
 *  limit may have cut it), so nothing is hollowed on a guess.
 *  shortcut: ancestry is judged inside the loaded window — a shown commit
 *  whose only path from the upstream runs through older, unloaded commits
 *  reads as unpushed; upgrade to a server-side rev-list if that ever shows. */
export function unpushed(commits: GitCommit[], upstream: string | undefined): Set<string> {
  if (!upstream) return new Set();
  const by = new Map(commits.map((c) => [c.sha, c]));
  const head = commits.find((c) => c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> ")));
  const up = commits.find((c) => c.refs.includes(upstream));
  if (!head || !up) return new Set();
  const reach = (from: GitCommit) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      for (const p of c.parents) {
        const pc = by.get(p);
        if (pc) stack.push(pc);
      }
    }
    return seen;
  };
  const theirs = reach(up);
  return new Set([...reach(head)].filter((sha) => !theirs.has(sha)));
}
