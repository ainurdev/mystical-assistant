// Run: node --experimental-strip-types src/lib/branchorder.check.ts  (from web/)
//
// The WORKTREE picker shows eight chips of a list that can run to hundreds. If
// the order is wrong the eight are the wrong eight, and the checkout you came
// for sits behind SHOW ALL.
import { orderBranches } from "./branchorder.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const same = (got: string[], want: string[], what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

// Git hands branches over newest commit first; that order is the tiebreak throughout.
const recency = ["main", "feat/a", "old/b", "feat/c", "old/d"];
const held = new Set(["main", "feat/c"]); // the project checkout + one linked worktree

same(orderBranches(recency, "main", held), ["main", "feat/c", "feat/a", "old/b", "old/d"],
  "checkouts lead, the rest keep git's order");
same(orderBranches(recency, "old/d", held), ["old/d", "main", "feat/c", "feat/a", "old/b"],
  "the pick leads even when it has no checkout");
same(orderBranches(recency, "feat/c", held), ["feat/c", "main", "feat/a", "old/b", "old/d"],
  "a picked worktree moves up, it is not listed twice");
same(orderBranches(recency, "gone", held), ["main", "feat/c", "feat/a", "old/b", "old/d"],
  "a pick that is not in the list adds nothing");
same(orderBranches(recency, "main", new Set()), recency,
  "no worktree answer yet — git's order, untouched");

// The repo that prompted this: 252 branches, 21 of them checked out, spread
// through the recency order. Every chip above the fold has to be a checkout.
const many = Array.from({ length: 252 }, (_, i) => `b${i}`);
const out = new Set(many.filter((_, i) => i % 12 === 0));
ok(out.size === 21, "fixture has 21 checkouts");
ok(orderBranches(many, "b0", out).slice(0, 8).every((b) => out.has(b)),
  "21 checkouts among 252 branches — the first 8 are all checkouts");

const input = [...recency];
orderBranches(input, "old/d", held);
same(input, recency, "the caller's list is not reordered in place");

console.log("\nall branchorder checks passed");
