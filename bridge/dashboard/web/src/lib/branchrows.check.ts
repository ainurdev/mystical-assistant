// Run: node bridge/dashboard/web/src/lib/branchrows.check.ts
import { branchGroups, type BranchRow } from "./branchrows.ts";

const row = (name: string, at: number, extra: Partial<BranchRow> = {}): BranchRow => ({
  name, at, ahead: 0, behind: 0, upstream: "", unpushed: null,
  worktree: null, main: false, dirty: null, merged: false, ...extra,
});
const rows: BranchRow[] = [
  row("feat/old", 50, { merged: true }),
  row("feat/plain", 40),
  row("main", 30, { worktree: "/r/main", upstream: "origin/main", unpushed: 0 }),
  row("feat/here", 10, { worktree: "/w/here" }),
  row("feat/busy", 5, { worktree: "/w/busy" }),
  row("feat/idle", 60, { worktree: "/w/idle" }),
  row("", 1, { head: "c09dd80", worktree: "/r", main: true, behind: 109 }),
];
const g = branchGroups(rows, "main", "feat/here", new Map([["feat/busy", "working"]]));

console.assert(g.worktrees.map((r) => r.label).join() === "here,busy,idle,main,detached · c09dd80",
  `here, then working, then newest, then the base, then a detached checkout; got ${g.worktrees.map((r) => r.label)}`);
console.assert(g.worktrees[0].here && !g.worktrees[1].here, "only the open session's branch is HERE");
console.assert(g.worktrees[1].activity === "working" && g.worktrees[2].activity === null, "activity rides along");
console.assert(g.worktrees[3].base && !g.worktrees[0].base, "the base is marked");
console.assert(g.branches.map((r) => r.name).join() === "feat/plain", "a branch without a checkout, not merged");
console.assert(g.merged.map((r) => r.name).join() === "feat/old", "merged and without a checkout");

const asks = branchGroups([row("feat/a", 1, { worktree: "/w/a" }), row("feat/b", 9, { worktree: "/w/b" })], "main", null,
  new Map([["feat/a", "asking"]]));
console.assert(asks.worktrees[0].name === "feat/a", "a branch waiting on you comes before a newer idle one");
console.log("branchrows ok");
