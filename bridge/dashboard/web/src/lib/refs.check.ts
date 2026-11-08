// node --experimental-strip-types src/lib/refs.check.ts
import assert from "node:assert/strict";
import { imagesIn, isImage, refOf, refsInText, remarkFileRefs } from "./refs.ts";

for (const [raw, want] of [
  ["src/App.tsx", "src/App.tsx"], ["src/App.tsx:12", "src/App.tsx:12"], ["handler.ts", "handler.ts"], ["./a/b", "./a/b"],
  ["/home/m/x/shot.png", "/home/m/x/shot.png"], ["~/shots/a.png", "~/shots/a.png"], ["bridge/dashboard/web", "bridge/dashboard/web"],
  ["src/lib/", "src/lib/"], ["Node.js", "Node.js"],
  ["and/or", null], ["client/server", null], ["1/2", null], ["--force", null], ["npm run build", null], ["useState", null],
  ["https://x.io/a.ts", null], ["v1.2.3", null], ["e.g.", null], ["/", null], ["a=b.ts", null],
] as const) assert.equal(refOf(raw), want, raw);

const found = (t: string) => refsInText(t).map((r) => r.address);
assert.deepEqual(found("See src/App.tsx, then bridge/a.py:12. Done."), ["src/App.tsx", "bridge/a.py:12"]);
assert.deepEqual(found("(tests/x.py)"), ["tests/x.py"]);
assert.deepEqual(found("go to https://x.io/a.ts now"), []);
assert.deepEqual(found("mail me@site.md please"), []);
assert.deepEqual(found("it took 1/2 of and/or"), []);
const r = refsInText("x a/b.ts.")[0];
assert.equal("x a/b.ts.".slice(r.start, r.end), "a/b.ts");

assert.equal(isImage("a/b.PNG:4"), true);
assert.equal(isImage("a/b.ts"), false);
assert.deepEqual(imagesIn("Saved `.mystical/a.png` and b/c.jpg, again b/c.jpg"), [".mystical/a.png", "b/c.jpg"]);
assert.deepEqual(imagesIn("![x](a/in.png) and [y](a/link.png)\n```\nls a/fence.png\n```"), []);
assert.equal(imagesIn(Array.from({ length: 9 }, (_, i) => `a/${i}.png`).join(" ")).length, 6);

const tree = { type: "root", children: [{ type: "paragraph", children: [
  { type: "text", value: "open a/b.ts now" },
  { type: "link", children: [{ type: "text", value: "c/d.ts" }] },
  { type: "inlineCode", value: "e/f.ts" }] }] };
remarkFileRefs()(tree as never);
const kids = (tree.children[0] as { children: { type: string; value?: string; data?: { hProperties?: { addr?: string } } }[] }).children;
assert.deepEqual(kids.map((k) => k.type), ["text", "fileRef", "text", "link", "inlineCode"]);
assert.equal(kids[1].data?.hProperties?.addr, "a/b.ts");
console.log("refs ok");
