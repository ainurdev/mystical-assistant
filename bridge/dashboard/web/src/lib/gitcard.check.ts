// Run: node --experimental-strip-types src/lib/gitcard.check.ts  (from web/)
//
// The GIT tab's status card (A · PIPE): one step, a headline that says the
// situation, and three stops that show where the work sits.
import { gitCard, type CardIn } from "./gitcard.ts";
import type { PrInfo } from "../api.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const synced = { kind: "synced", upstream: "origin/feat" } as const;
const at = (o: Partial<CardIn>) => gitCard({ sync: synced, dirty: 0, staged: 0, up: 0, down: 0, base: "master", shippedN: 0, pr: null, canSend: true, fresh: "1m ago", ...o });
const pr = (o: Partial<PrInfo>): PrInfo => ({
  number: 231, title: "Skills install", url: "", state: "OPEN", base: "master", head: "feat", sha: "", additions: 0, deletions: 0,
  created: "", merged_at: "", checks: [], passed: 0, failed: 0, running: 0, total: 0, decision: "", requested: [], reviews: [],
  review: null, status: "open", draft: false, ...o,
} as PrInfo);

const c1 = at({ sync: { kind: "ahead", n: 5, upstream: "origin/feat" }, dirty: 3, up: 5 });
ok(c1.step === "commit" && !c1.amber, "edits first: commit, accent");
ok(c1.head === "Your work is still on this Mac" && c1.sub === "Commit 3 files, then push.", "commit headline and sub");
ok(c1.stops[0].tone === "on" && c1.stops[0].value === "3 files", "this Mac is the lit stop");
ok(c1.stops[1].value === "5 to push" && c1.stops[1].tone === "", "committed waits, not lit");
ok(c1.stops[2].value === "1m ago" && c1.stops[2].tone === "dim", "origin says how fresh");
ok(at({ dirty: 3, staged: 2 }).sub === "Commit 2 of 3 files, then push.", "staged: the commit takes only those");
ok(at({ sync: { kind: "local" }, dirty: 1 }).sub === "Commit 1 file.", "no remote: nothing to push after");

const p = at({ sync: { kind: "ahead", n: 2, upstream: "origin/feat" }, up: 2 });
ok(p.step === "push" && p.stops[1].tone === "on" && p.stops[0].value === "clean", "push: committed is lit, the Mac is clean");
ok(at({ sync: { kind: "publish", n: 4 }, up: 4 }).stops[2].value === "not on origin yet", "never pushed");

const b = at({ sync: { kind: "behind", n: 2, upstream: "origin/feat" }, down: 2 });
ok(b.step === "sync" && b.amber && b.stops[2].tone === "ask" && b.stops[2].value === "2 new", "behind: amber, origin has 2 new");
const d = at({ sync: { kind: "diverged", ahead: 1, behind: 2, upstream: "origin/feat" }, up: 1, down: 2 });
ok(d.step === "sync" && d.head === "You and origin both moved" && d.sub === "1 here, 2 on origin. Merge them in.", "diverged");

const r = at({ shippedN: 3 });
ok(r.step === "pr" && r.head === "Ready for a pull request" && r.sub === "3 commits on origin aren't in master.", "shipped with no PR: open one");
ok(r.stops[2].tone === "on", "the PR step lights origin");

const f = at({ shippedN: 8, pr: pr({ failed: 1, checks: [{ name: "web / check", state: "fail" } as PrInfo["checks"][number]] }) });
ok(f.step === "fix" && f.amber && f.head === "PR #231 has a failing check", "a failed check needs you");
ok(f.sub === "web / check failed. Everything is pushed." && f.stops[2].value === "PR · 1 failed", "names the check");
ok(f.stops[0].tone === "ok" && f.stops[1].value === "all pushed", "done stops are green");
const rv = at({ shippedN: 2, pr: pr({ review: { by: "mahdi", at: "", body: "", comments: [] } }) });
ok(rv.step === "fix" && rv.head === "PR #231 has review comments", "a review asking for changes");
ok(at({ shippedN: 2, canSend: false, pr: pr({ review: { by: "m", at: "", body: "", comments: [] } }) }).step === null, "no chat to send to: no review step");

ok(at({ shippedN: 2, pr: pr({ running: 2, total: 3 }) }).head === "PR #231 is open", "an open PR, nothing wrong");
ok(at({}).head === "All in master" && at({}).step === null, "all clean");
ok(at({ base: "" }).head === "Everything is pushed", "no base read yet");
ok(at({ sync: { kind: "local" } }).sub === "This branch has no remote.", "no remote, nothing to do");
