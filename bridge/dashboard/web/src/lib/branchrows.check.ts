// Run: node bridge/dashboard/web/src/lib/branchrows.check.ts
import { branchGroups, CHIPS, type BranchRow } from "./branchrows.ts";

const row = (name: string, at: number, extra: Partial<BranchRow> = {}): BranchRow => ({
  name, at, subject: "", sha: `${name}-tip`, ahead: 0, behind: 0, upstream: "", unpushed: null,
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

// A squash merge: git still counts its commit ahead, but the PR merged at its tip.
// An older merged PR on a branch that moved on (staging after #131) says nothing.
const prs = branchGroups([
  row("fix/squashed", 3, { ahead: 1, upstream: "origin/fix/squashed", unpushed: 0 }),
  row("staging", 2, { ahead: 17, behind: 113, worktree: "/w/staging" }),
  row("feat/open", 1, { ahead: 4, worktree: "/w/open", dirty: 2 }),
  row("feat/fresh", 0, { worktree: "/w/fresh", merged: true }),
  row("feat/done", 0, { worktree: "/w/done", merged: true, behind: 3 }),
], "main", null, new Map([["feat/open", "working"]]), {
  "fix/squashed": { number: 163, state: "MERGED", status: "merged", sha: "fix/squashed-tip", failed: 0 },
  "staging": { number: 131, state: "MERGED", status: "merged", sha: "older", failed: 0 },
  "feat/open": { number: 170, state: "OPEN", status: "failing", sha: "feat/open-tip", failed: 2 },
});
const by = new Map(prs.all.map((r) => [r.name, r]));
console.assert(prs.merged.map((r) => r.name).join() === "fix/squashed", "a PR merged at the tip lands the branch");
console.assert(by.get("staging")!.pr === null && !by.get("staging")!.landed, "an older merged PR is no chip and no landing");
console.assert(by.get("feat/open")!.pr?.number === 170, "an open PR rides along");
console.assert(!by.get("feat/fresh")!.landed && by.get("feat/done")!.landed,
  "a checkout at the base's own commit hasn't landed; one the base moved past has");
const count = (k: keyof typeof CHIPS) => prs.all.filter(CHIPS[k]).map((r) => r.name).join();
console.assert(count("working") === "feat/open" && count("uncommitted") === "feat/open", "working, uncommitted");
console.assert(count("waiting") === "", "nothing waits on you here");
console.assert(count("unmerged") === "staging,feat/open", `unmerged: ahead and not landed; got ${count("unmerged")}`);
console.assert(count("merged") === "fix/squashed,feat/done", `merged: landed; got ${count("merged")}`);
console.log("branchrows ok");
