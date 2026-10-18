// Run: node --experimental-strip-types src/lib/gitsync.check.ts  (from web/)
//
// The GIT tab's sync state and the rail badge it lends: every state names the
// one thing a button can do, and nothing is offered that git would refuse.
import { syncBadge, syncOf } from "./gitsync.ts";
import type { GitStatus } from "../api.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const st = (o: Partial<GitStatus>): GitStatus =>
  ({ is_repo: true, branch: "master", upstream: "origin/master", ahead: 0, behind: 0, dirty: 0, files: [], ...o });
const kind = (o: Partial<GitStatus>) => syncOf(st(o)).kind;

ok(syncOf(null).kind === "none" && kind({ is_repo: false }) === "none", "no repo, no state");
ok(kind({ upstream: undefined }) === "none", "an old backend's missing upstream is not a guess");
ok(kind({}) === "synced", "in step");
ok(JSON.stringify(syncOf(st({ ahead: 3 }))) === JSON.stringify({ kind: "ahead", n: 3, upstream: "origin/master" }), "ahead");
ok(kind({ behind: 4 }) === "behind", "behind");
ok(kind({ ahead: 3, behind: 2 }) === "diverged", "both ways is diverged, not push or pull");
ok(kind({ branch: "(detached)", upstream: "" }) === "detached", "detached HEAD has no branch to publish");
ok(JSON.stringify(syncOf(st({ upstream: "", unpublished: 2 }))) === JSON.stringify({ kind: "publish", n: 2 }), "never pushed");
ok(kind({ upstream: "", unpublished: null }) === "local", "no origin: nothing to publish to");
ok(syncOf(st({ upstream: "" })).kind === "publish", "a backend without the count still reads as publish");

const badge = (o: Partial<GitStatus>) => syncBadge(syncOf(st(o)));
ok(badge({}) === null, "up to date: no badge");
ok(badge({ ahead: 3 }) === "↑3" && badge({ behind: 4 }) === "↓4", "↑n / ↓n");
ok(badge({ ahead: 1, behind: 1 }) === "↑↓", "diverged");
ok(badge({ upstream: "", unpublished: 2 }) === "↑2", "unpublished commits");
ok(badge({ upstream: "", unpublished: 0 }) === null, "a fresh branch with nothing of its own: no badge");
ok(badge({ ahead: 250 }) === "↑99+", "capped for the pill");
