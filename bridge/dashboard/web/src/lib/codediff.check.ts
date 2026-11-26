// node --experimental-strip-types src/lib/codediff.check.ts
import assert from "node:assert/strict";
import { changedWords, commentSpans, diffLines, lines, pieces, splitRows, tokLines, unifiedRows, type DiffFile } from "./codediff.ts";

// The diff rebuilds both sides, and is as short as a brute-force LCS says it can be.
let seed = 3;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const lcs = (a: string[], b: string[]) => {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t[0][0];
};
for (let t = 0; t < 400; t++) {
  const a = Array.from({ length: Math.floor(rnd() * 30) }, () => "abcde"[Math.floor(rnd() * 5)]);
  const b = rnd() < 0.3 ? [...a] : Array.from({ length: Math.floor(rnd() * 30) }, () => "abcde"[Math.floor(rnd() * 5)]);
  const ops = diffLines(a, b);
  assert.deepEqual(ops.filter((o) => o.kind !== "add").map((o) => a[o.a]), a);
  assert.deepEqual(ops.filter((o) => o.kind !== "del").map((o) => b[o.b]), b);
  assert.equal(ops.filter((o) => o.kind === "same").length, lcs(a, b), `${a.join("")} → ${b.join("")}`);
}
// Big and fully different stays quick and still correct.
const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`), other = Array.from({ length: 4000 }, (_, i) => `other ${i}`);
const t0 = performance.now();
assert.equal(diffLines(big, other).length, 8000);
assert.ok(performance.now() - t0 < 1500, "a 4000-line rewrite took too long");

// Words within a changed line; nothing when the line was rewritten.
assert.deepEqual(changedWords("return a + 1;", "return a + 2;"), { old: [[11, 13]], new: [[11, 13]] });
assert.deepEqual(changedWords("foo()", "completely different words here"), { old: [], new: [] });

// Line numbers count from where the excerpt starts.
const abc = "abcdefghijklmnopqrst".split("");
const f: DiffFile = { path: "a.ts", language: "ts", old: abc.join("\n"), new: abc.map((c) => (c === "i" ? "I" : c)).join("\n"), old_start: 10, new_start: 20, comments: [{ side: "old", from: [10, 1], to: [10, 1], text: "first" }] };
const ls = lines(f, diffLines(f.old!.split("\n"), f.new.split("\n")));
assert.deepEqual(ls.filter((l) => l.kind !== "same").map((l) => [l.kind, l.o, l.n, l.text]), [["del", 18, null, "i"], ["add", null, 28, "I"]]);
// Unchanged lines far from a change fold away, but not the one a comment is on.
const u = unifiedRows(f, ls);
assert.equal(("text" in u[0]) && u[0].text, "a");
// Shown: "a" (it has a comment) and 3 after it, the change at "i" and 3 either side. The one line
// between those stays (folding one line saves nothing); the 8 after the change fold.
assert.ok(u.some((r) => "gap" in r && r.gap === 8), JSON.stringify(u.map((r) => ("gap" in r ? `gap${r.gap}` : r.text))));
// Side by side: a changed line faces what it became.
const sp = splitRows(f, ls).filter((r) => !("gap" in r)) as { left: { text: string } | null; right: { text: string } | null }[];
assert.ok(sp.some((r) => r.left?.text === "i" && r.right?.text === "I"));

// A comment's characters, 1-based in, 0-based [start, end) out, across lines.
const cs = [{ side: "new" as const, from: [2, 20] as [number, number], to: [3, 4] as [number, number], text: "x" }];
assert.deepEqual(commentSpans(cs, "new", 2, 30), [{ span: [19, 30], i: 0 }]);
assert.deepEqual(commentSpans(cs, "new", 3, 30), [{ span: [0, 4], i: 0 }]);
assert.deepEqual(commentSpans(cs, "old", 2, 30), []);
// Pieces: cut where syntax, changed words or comments change, and keep the text whole.
const ps = pieces("let x = 10;", [{ text: "let", cls: "tok-keyword" }, { text: " x = ", cls: "" }, { text: "10", cls: "tok-number" }, { text: ";", cls: "" }], [[8, 10]], [{ span: [4, 10], i: 0 }]);
assert.equal(ps.map((p) => p.text).join(""), "let x = 10;");
assert.deepEqual(ps.find((p) => p.text === "10"), { text: "10", cls: "tok-number", changed: true, notes: [0] });
assert.deepEqual(ps.find((p) => p.text === "let"), { text: "let", cls: "tok-keyword", changed: false, notes: [] });
assert.deepEqual(tokLines([{ text: "a\nb", cls: "s" }, { text: "c", cls: "" }]), [[{ text: "a", cls: "s" }], [{ text: "b", cls: "s" }, { text: "c", cls: "" }]]);
console.log("codediff ok");
