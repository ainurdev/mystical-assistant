// Run: node --experimental-strip-types src/lib/issuebranch.check.ts  (from web/)
//
// This string becomes a git ref AND a directory on disk. Git rejects most of
// what an issue title can contain, and a bad name fails the worktree at the
// point someone pressed one button expecting a branch.
import { branchForIssue } from "./issuebranch.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(got === want, `${what} — got ${JSON.stringify(got)}`);

eq(branchForIssue(12, "Add a login form"), "issue-12-add-a-login-form", "plain title");
eq(branchForIssue(7, "Fix crash in Foo::bar()"), "issue-7-fix-crash-in-foo-bar", "punctuation collapses");
eq(branchForIssue(3, "  spaced  out  "), "issue-3-spaced-out", "no leading or trailing dash");
eq(branchForIssue(9, "…"), "issue-9", "a title that slugs to nothing still names the branch");
eq(branchForIssue(4, ""), "issue-4", "an empty title is not a crash");
eq(branchForIssue(5, "../../etc/passwd"), "issue-5-etc-passwd", "no path traversal reaches the worktree dir");
eq(branchForIssue(6, "a".repeat(200)), `issue-6-${"a".repeat(40)}`, "long titles are capped");
eq(branchForIssue(8, `${"b".repeat(39)} tail`), `issue-8-${"b".repeat(39)}`, "a cut at a separator leaves no trailing dash");

// Whatever a title throws at it, the result stays inside git's safe subset.
for (const title of ["HEAD~1", "feat: a^b", "with.a.dot.", "-leading", "trailing-", "ünïcödé", "a\\b"]) {
  const b = branchForIssue(1, title);
  ok(/^[a-z0-9-]+$/.test(b), `only [a-z0-9-] for ${JSON.stringify(title)} → ${b}`);
  ok(!b.includes(".."), `no .. for ${JSON.stringify(title)}`);
  ok(!b.endsWith("-") && !b.endsWith("."), `no trailing separator for ${JSON.stringify(title)}`);
}

console.log("\nall issuebranch checks passed");
