// Run: node bridge/dashboard/web/src/lib/worddiff.check.ts
import { wordDiff } from "./worddiff.ts";

const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`FAIL: ${what} — got ${JSON.stringify(got)}`);
  console.log(`ok - ${what}`);
};
const after = (before: string, next: string) => wordDiff(before, next).filter((p) => p.kind !== "del").map((p) => p.text).join("");
const was = (before: string, next: string) => wordDiff(before, next).filter((p) => p.kind !== "add").map((p) => p.text).join("");

eq(wordDiff("a b", "a b"), [{ kind: "same", text: "a b" }], "nothing changed");
eq(wordDiff("", ""), [], "both empty");
eq(wordDiff("", "new"), [{ kind: "add", text: "new" }], "all new");
eq(wordDiff("old", ""), [{ kind: "del", text: "old" }], "all gone");
eq(wordDiff("watch a PR now", "watch your PR now").filter((p) => p.kind !== "same").map((p) => p.text), ["your", "a"], "one word swapped");
for (const [a, b] of [["one two three", "one three four"], ["x\ny  z", "x y z"], ["a a a", "a b a"]]) {
  eq(after(a, b), b, `the new text survives: ${a}`);
  eq(was(a, b), a, `the old text survives: ${a}`);
}
const long = Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ");
eq(wordDiff(long, `${long} more`).map((p) => p.kind), ["del", "add"], "a huge one is a rewrite");
