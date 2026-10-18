// Run: node bridge/dashboard/web/src/lib/gitgraph.check.ts
import { layout, unpushed } from "./gitgraph.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const c = (sha: string, parents: string[], refs: string[] = []) =>
  ({ sha, parents, refs, author: "a", ts: 0, subject: sha });
// a ← b ← c(merge of d and x) ← d, with x a side commit off d; origin/master is on d
const log = [c("a", ["b"], ["HEAD -> master"]), c("b", ["c"]), c("c", ["d", "x"]), c("x", ["d"], ["feat"]), c("d", [], ["origin/master"])];
const { rows, width } = layout(log);
ok(width === 2, "the merge opens a second lane");
ok(rows[0].edges.length === 1 && rows[0].edges[0].seg === "out", "HEAD's row only has a rail leaving it");
ok(rows[1].edges.some((e) => e.seg === "in") && rows[1].edges.some((e) => e.seg === "out"), "a middle row's rail enters and leaves");
ok(rows[3].lane === 1 && rows[3].edges.some((e) => e.seg === "thru" && e.a === 0), "the mainline runs past the side commit");
ok(rows[4].edges.every((e) => e.seg === "in"), "the root only has rails arriving");
ok([...unpushed(log, "origin/master")].sort().join() === "a,b,c,x", "everything HEAD reaches that the upstream doesn't: the merge and its side commit");
// master fast-forwarded onto a branch that merged origin/master in as its SECOND parent
const ff = [c("m", ["f2", "o"], ["HEAD -> master"]), c("f2", ["f1"]), c("o", ["b"], ["origin/master"]), c("f1", ["b"]), c("b", [])];
ok([...unpushed(ff, "origin/master")].sort().join() === "f1,f2,m", "a first-parent walk would miss the upstream here; ancestry doesn't");
ok(unpushed(log, "origin/other").size === 0, "an upstream outside the loaded log hollows nothing");
ok(unpushed(log, undefined).size === 0, "no upstream, nothing unpushed");
ok(unpushed(log.slice(1), "origin/master").size === 0, "no HEAD in the log (a branch view), nothing hollowed");
