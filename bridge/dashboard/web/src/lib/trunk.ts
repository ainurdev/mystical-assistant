import type { ShownRow } from "./branchrows";

/* The Branches hero's data: the trunk (main) with one fork per worktree row.
   At most MAX tips, alternating high and low so neighbours don't touch; the
   rest are counted in `more`. The legend counts every row, the base apart. */
export type TrunkState = "waits" | "working" | "pr" | "clean" | "local" | "base";
export const MAX = 8;
export const ORDER: TrunkState[] = ["waits", "working", "pr", "clean", "local"];

/** branchrows' row -> the hero's six states: a session on it (waits on you,
 *  then running) outranks what the branch itself is; then the base, an open PR,
 *  landed work (clean-up is offered), else local. */
export function trunkState(r: ShownRow): TrunkState {
  if (r.activity === "asking") return "waits";
  if (r.activity === "working") return "working";
  if (r.base) return "base";
  if (r.pr?.state === "OPEN") return "pr";
  if (r.landed) return "clean";
  return "local";
}

/** x is 0..1 across the trunk. */
export function trunk(rows: { name: string; state: TrunkState }[]) {
  const shown = rows.slice(0, MAX), n = shown.length;
  const tips = shown.map((r, i) => ({ ...r, x: n === 1 ? 0.5 : 0.08 + (0.84 * i) / (n - 1), low: i % 2 === 1 }));
  const legend = ORDER.map((state) => ({ state, count: rows.filter((r) => r.state === state).length })).filter((l) => l.count);
  return { tips, legend, more: rows.length - shown.length };
}
