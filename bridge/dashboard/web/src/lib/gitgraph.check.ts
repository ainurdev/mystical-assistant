// Run: node bridge/dashboard/web/src/lib/gitgraph.check.ts
// Guards the lane layout: a branch that forks and merges back must occupy its
// own lane for exactly its own commits, and the merge must draw a rail from
// both parents.
import { layout } from "./gitgraph.ts";
import type { GitCommit } from "../api.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const c = (sha: string, ...parents: string[]): GitCommit =>
  ({ sha, parents, author: "a", ts: 0, refs: [], subject: sha });

//  M3 (merge of M2 + F2)
//  ├─ F2
//  │  F1
//  M2 ┘
//  M1
const history = [
  c("M3", "M2", "F2"),
  c("F2", "F1"),
  c("F1", "M2"),
  c("M2", "M1"),
  c("M1"),
];
const { rows, width } = layout(history);
const byShaLane = new Map(rows.map((r) => [r.c.sha, r.lane]));

ok(width === 2, "a single side branch uses two lanes");
ok(byShaLane.get("M3") === 0 && byShaLane.get("M2") === 0 && byShaLane.get("M1") === 0,
   "mainline stays in lane 0");
ok(byShaLane.get("F1") === 1 && byShaLane.get("F2") === 1, "the branch gets its own lane");

// The merge row must send a rail to each parent lane (0 = M2, 1 = F2).
const merge = rows[0];
const down = merge.edges.filter((e) => e.y2 === 28).map((e) => e.b).sort();
ok(down.length === 2 && down[0] === 0 && down[1] === 1, "merge draws a rail to both parents");

// F1's row: the mainline rail passes straight through lane 0 while F1 sits in 1.
const f1 = rows[2];
ok(f1.edges.some((e) => e.a === 0 && e.b === 0), "mainline passes through under a branch commit");

// Parents outside the fetched window must not leave dangling lanes.
const truncated = layout([c("X", "gone")]);
ok(truncated.rows[0].edges.length === 0 && truncated.width === 1,
   "a parent past the log limit draws nothing");

console.log("all ok");
