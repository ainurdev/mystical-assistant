// Run: node --experimental-strip-types src/lib/pushfailed.check.ts  (from web/)
//
// The draft a failed push hands to a new session: it has to name the branch,
// carry git's reason verbatim, and stay readable when a hook prints pages.
import { divergedDraft, pushFailedDraft } from "./pushfailed.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const rejected = " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n";
const d = pushFailedDraft("main", rejected);
ok(d.startsWith("Pushing `main` failed:"), "names the branch");
ok(d.includes("```\n! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n```"), "git's words, fenced and trimmed");
ok(d.endsWith("then push."), "ends with the ask");
ok(pushFailedDraft(null, rejected).startsWith("Pushing this branch failed:"), "no branch still reads");
ok(pushFailedDraft("x", "  ").includes("(git printed nothing)"), "empty output is said, not a blank fence");

const hook = "line\n".repeat(2000) + "error: the reason";
const long = pushFailedDraft("x", hook);
ok(long.includes("…") && long.includes("error: the reason"), "long output keeps its tail");
ok(long.length < 3400, `long output is capped (${long.length})`);

const dv = divergedDraft("master", "origin/master", 3, 1);
ok(dv.startsWith("`master` has diverged from `origin/master`: 3 commits here, 1 commit there"), "diverged names both sides and counts");
ok(!dv.includes("failed") && dv.endsWith("then push."), "diverged claims no failed push, ends with the ask");
