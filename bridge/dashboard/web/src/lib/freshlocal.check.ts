// Run: node --experimental-strip-types src/lib/freshlocal.check.ts  (from web/)
//
// The fresh screen's LOCAL list decides whether "clean up local" or "merge the
// N idle" is due. Wrong order hides the busy branches below the fold; a wrong
// merge list sends a prompt that merges work still in progress.
import { localRows, mergeable, mergeClause, startWith } from "./freshlocal.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const same = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

// rivendell on 2026-10-23, in git's order (newest commit first).
const branches = ["main", "feat/inbox-minimal", "feat/communications", "feat/notifications-v2",
  "feat/provider-sync", "feat/project-logos-one", "fix/commit-sync-from-head", "feat/book-dialog", "old/stale"];
const held = new Set(["feat/communications", "feat/inbox-minimal", "feat/notifications-v2",
  "feat/project-logos-one", "feat/provider-sync", "fix/commit-sync-from-head"]);
const sessions = [
  { id: "n1", branch: "feat/notifications-v2", title: "Notification audit (old)", updated: 100 },
  { id: "n2", branch: "feat/notifications-v2", title: "Notification System Audit", updated: 900 },
  { id: "c", branch: "feat/communications", title: "Meetings List", updated: 880 },
  { id: "i", branch: "feat/inbox-minimal", title: "Minimal Inbox", updated: 890 },
  { id: "p", branch: "feat/provider-sync", title: "Provider Spam", updated: 870 },
  { id: "b", branch: "feat/book-dialog", title: "Allocation Team", updated: 500 },
  { id: "m", branch: "main", title: "on main", updated: 999 },
];
const working = new Set(["n2", "c", "i"]);
const rows = localRows(branches, "main", held, new Set(), sessions, (id) => working.has(id));

same(rows.map((r) => r.branch), ["feat/inbox-minimal", "feat/communications", "feat/notifications-v2",
  "feat/provider-sync", "feat/book-dialog", "feat/project-logos-one", "fix/commit-sync-from-head", "old/stale"],
  "busy first, then done newest first, then worktrees, then the rest in git's order");
ok(!rows.some((r) => r.branch === "main"), "the default branch is not a row");
same(rows.find((r) => r.branch === "feat/notifications-v2")?.session?.id, "n2", "a branch shows its newest session");
same(mergeable(rows), ["feat/provider-sync", "feat/book-dialog", "feat/project-logos-one", "fix/commit-sync-from-head"],
  "merge = idle open work: not busy, not the stale branch nobody holds");

const merged = localRows(branches, "main", held, new Set(["feat/provider-sync"]), sessions, (id) => working.has(id));
ok(!mergeable(merged).includes("feat/provider-sync"), "a branch already in main is not merged again");

same(localRows(["master"], "master", new Set(), new Set(), [], () => false), [], "only the default branch — no rows");

same(mergeClause(["a", "b"], "main"), "merge a, b into main, then clean up local", "the merge prompt names its branches");
same(startWith("clean up local", true, ""), "clean up local, then ", "an open starter leaves the box on its 'then'");
same(startWith("clean up local", true, "  fix the inbox\n"), "clean up local, then fix the inbox",
  "a starter goes in front of what you typed");
same(startWith("merge a into main, then clean up local", false, ""), "merge a into main, then clean up local",
  "a closed starter is a whole prompt");
