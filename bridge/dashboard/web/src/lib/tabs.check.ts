// Run: node --experimental-strip-types src/lib/tabs.check.ts  (from web/)
//
// Closing a tab and renaming a file both move buffers around, and a buffer can
// hold unsaved edits — a wrong path here silently drops someone's work. Pin the
// subtree and focus rules.
import { nextFocus, remapPaths, tabLabels, underPath } from "./tabs.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

ok(underPath("a/b", "a/b"), "a path is under itself");
ok(underPath("a/b", "a/b/c.ts"), "a child is under its directory");
ok(!underPath("a/b", "a/bc.ts"), "a name prefix is not a subtree");
ok(!underPath("a/b", "x/a/b"), "a suffix match is not a subtree");

const tabs = ["src/a.ts", "src/nest/b.ts", "README.md"];

eq(remapPaths(tabs, "src/a.ts", "src/z.ts"), ["src/z.ts", "src/nest/b.ts", "README.md"],
  "rename keeps the tab in place");
eq(remapPaths(tabs, "src/nest", "src/deep"), ["src/a.ts", "src/deep/b.ts", "README.md"],
  "renaming a directory moves its files");
eq(remapPaths(tabs, "src/nest", null), ["src/a.ts", "README.md"],
  "deleting a directory closes its files");
eq(remapPaths(tabs, "docs", null), tabs, "an unrelated delete changes nothing");

eq(nextFocus(tabs, "src/a.ts", ["src/nest/b.ts", "README.md"]), "src/nest/b.ts",
  "closing a tab focuses the one on its right");
eq(nextFocus(tabs, "README.md", ["src/a.ts", "src/nest/b.ts"]), "src/nest/b.ts",
  "closing the last tab focuses the new last");
eq(nextFocus(tabs, "src/a.ts", []), null, "closing the only tab focuses nothing");
eq(nextFocus(tabs, "src/nest/b.ts", ["src/a.ts"]), "src/a.ts",
  "a subtree delete falls back to the left when nothing survives on the right");

eq(tabLabels(tabs), ["a.ts", "b.ts", "README.md"], "unique names stay bare");
eq(tabLabels(["a/SKILL.md", "b/SKILL.md", "README.md"]),
  ["a/SKILL.md", "b/SKILL.md", "README.md"], "clashing names gain their parent");
eq(tabLabels(["x/y/z/SKILL.md", "q/SKILL.md"]), ["z/SKILL.md", "q/SKILL.md"],
  "only one level of parent is added");
eq(tabLabels(["SKILL.md"]), ["SKILL.md"], "a root-level file has no parent to add");

console.log("\nall tab checks passed");
