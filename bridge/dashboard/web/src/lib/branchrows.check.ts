// Run: node bridge/dashboard/web/src/lib/branchrows.check.ts
import { branchGroups, facts, nextStep, type BranchRow } from "./branchrows.ts";

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
const said = (n: string) => facts(by.get(n)!, "main").map((f) => f.t).join(" · ");
console.assert(said("staging") === "17 ahead, 113 behind · local", `staging: ${said("staging")}`);
console.assert(said("feat/open") === "PR checks failing · 2 uncommitted · 4 ahead", `three facts at most, PR first: ${said("feat/open")}`);
console.assert(facts(by.get("feat/open")!, "main")[0].tone === "err" && facts(by.get("feat/open")!, "main")[1].tone === "warn", "failing is red, uncommitted amber");
console.assert(said("fix/squashed") === "merged · PR #163", `a landed branch says only that: ${said("fix/squashed")}`);
console.assert(said("feat/fresh") === "same as main · local", `fresh: ${said("feat/fresh")}`);

// The next step: one per row, first match wins.
const step = (extra: Partial<BranchRow>, act: "working" | "asking" | null = null, pr?: Partial<NonNullable<Parameters<typeof branchGroups>[4]>[string]>) =>
  nextStep(branchGroups([row("feat/s", 1, extra)], "main", null, new Map(act ? [["feat/s", act]] : []),
    pr ? { "feat/s": { number: 7, state: "OPEN", status: "review", sha: "feat/s-tip", failed: 0, ...pr } } : {}).all[0]);
const WT = { worktree: "/w/s" };
console.assert(step({ ...WT, dirty: 3 }, "asking") === "answer", "waiting on you comes first");
console.assert(step({ ...WT, dirty: 3, ahead: 2 }, "working") === null, "a session working there: nothing to do");
console.assert(step({ ...WT, ahead: 2 }, null, { status: "conflicts", url: "u" }) === "resolve", "conflicts in a checkout: resolve");
console.assert(step({ ahead: 2 }, null, { status: "conflicts", url: "u" }) === "pr", "no checkout to resolve in: the PR link");
console.assert(step({ ...WT, ahead: 2 }, null, { status: "failing", url: "u" }) === "fix", "failing checks: fix");
console.assert(step({ ...WT, merged: true, behind: 4, dirty: 1 }) === "cleanup", "landed: clean up");
console.assert(step({ worktree: "/r", main: true, merged: true, behind: 4 }) === null, "the repo folder is never cleaned up");
console.assert(step({ ...WT, dirty: 3, ahead: 2 }) === "commit", "uncommitted: commit");
console.assert(step({ ...WT, ahead: 2, upstream: "o/s", unpushed: 0 }, null, { url: "u" }) === "pr", "an open PR: its link");
console.assert(step({ ...WT, ahead: 2, upstream: "o/s", unpushed: 0 }, null, {}) === null, "no link from an older bridge: nothing, not Open PR");
console.assert(step({ ...WT, ahead: 2, upstream: "o/s", unpushed: 2 }) === "push", "unpushed: push");
console.assert(step({ ahead: 2, upstream: "o/s", unpushed: 2 }) === "openpr", "push needs a checkout; pushed-ish without one: open a PR");
console.assert(step({ ...WT, ahead: 2, upstream: "o/s", unpushed: 0 }) === "openpr", "pushed, no PR: open one");
console.assert(step({ ahead: 2 }) === "merge", "local commits: merge");
console.assert(step({ ...WT }) === null, "same as the base: nothing");
const baseStep = (extra: Partial<BranchRow>) => nextStep(branchGroups([row("main", 1, { worktree: "/r", main: true, upstream: "o/main", ...extra })], "main", null, new Map()).all[0]);
console.assert(baseStep({ unpushed: 0 }) === null && baseStep({ unpushed: 3 }) === "push", "the base: only push");
console.assert(nextStep(g.worktrees[4]) === null, "a detached checkout: nothing");
console.log("branchrows ok");
