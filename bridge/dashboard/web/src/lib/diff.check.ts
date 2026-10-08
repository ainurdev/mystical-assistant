// Run: node bridge/dashboard/web/src/lib/diff.check.ts
//
// The GIT tab's diff numbers are what a review note cites to the agent, so
// they have to be the working tree's. ChangesTab's own parser (parseDiffRows,
// deleted in this change) counted deleted lines as well, so every number after
// a deletion was off by one more.
import { parseDiff } from "./diff.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const rows = parseDiff([
  "diff --git a/s.ts b/s.ts",
  "index 1111111..2222222 100644",
  "--- a/s.ts",
  "+++ b/s.ts",
  "@@ -31,4 +31,5 @@ export class S {",
  "   constructor() {}",
  "-  // TODO(inbox): group items by client",
  "+  group() {",
  "+    return 1;",
  "+  }",
  "   list() {}",
  "\\ No newline at end of file",
  "",
].join("\n"));

ok(rows.length === 7, "headers, the newline marker and the trailing newline are not rows");
ok(rows[0].kind === "hunk" && rows[0].ln === "", "the hunk header is a row with no number");
ok(rows[0].mark === "" && rows[0].text === "@@ -31,4 +31,5 @@ export class S {", "a hunk header prints its @@ once: in its text, not again as a mark");
ok(rows[1].ln === "31" && rows[1].text === "  constructor() {}", "context starts at the hunk's new-file line");
ok(rows[2].kind === "del" && rows[2].ln === "", "a deleted line has no working-tree number");
ok(rows[3].ln === "32" && rows[4].ln === "33" && rows[5].ln === "34", "added lines count on from the context, not past the deletion");
ok(rows[6].ln === "35", "context after the hunk's changes keeps counting");

const sneaky = parseDiff("@@ -1,2 +1,2 @@\n--- a SQL comment\n+++ a counter\n");
ok(sneaky[1].kind === "del" && sneaky[2].kind === "add", "inside a hunk, ---/+++ lines are content, not headers");

const two = parseDiff("@@ -1 +1 @@\n-a\n+b\ndiff --git a/t b/t\n--- a/t\n+++ b/t\n@@ -9 +9 @@\n-c\n+d\n");
ok(two.filter((r) => r.kind === "hunk").length === 2 && two[two.length - 1].ln === "9", "a second file's headers are skipped and its numbering restarts");

ok(parseDiff("Binary files /dev/null and b/x.png differ\n").length === 0, "a binary diff has no rows");

console.log("\nall diff checks passed");
