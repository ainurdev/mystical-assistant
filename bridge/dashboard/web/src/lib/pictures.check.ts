import assert from "node:assert/strict";
import { answerImages, isShowTool, lookedNotes, noteLine, proofsOf, withoutAnswered } from "./pictures.ts";

assert.ok(isShowTool("mcp__verify__Attach"));
assert.ok(isShowTool("mcp__verify__Record"));
assert.ok(isShowTool("Attach"));
assert.ok(!isShowTool("mcp__verify__Screenshot"));
assert.ok(!isShowTool("Read"));
assert.ok(!isShowTool("Attachment"));

const events = [
  { type: "tool", id: "a", name: "Read", summary: "x.png" },
  { type: "tool_done", id: "a", images: ["/u/x.png"] },
  { type: "tool", id: "b", name: "mcp__verify__Screenshot", summary: "page" },
  { type: "tool_done", id: "b", images: ["/u/s.png"] },
  { type: "text", text: "The **button** overlaps." },
  { type: "figure", kind: "shown", images: ["/u/fig-1-0-p.png"], caption: "After the fix", at: 5 },
  { type: "figure", kind: "compare", images: ["/u/b.png", "/u/c.png"], caption: "Before and after" },
  { type: "figure", kind: "compare", images: ["/u/one.png"], caption: "half" },
  { type: "tool", id: "c", name: "mcp__verify__Attach", summary: "clip" },
  { type: "tool_done", id: "c", images: ["/u/v.webm"], clip: { notes: "Checkout flow" } },
  { type: "tool", id: "d", name: "mcp__verify__Record", summary: "rec" },
  { type: "tool_done", id: "d" },
  { type: "tool", id: "e", name: "Read", summary: "y.png" },
  { type: "tool_done", id: "e", images: ["/u/y.png"] },
  { type: "text", text: "The answer" },
];
const p = proofsOf(events);
assert.deepEqual(p.map((x) => [x.kind, x.caption, x.tool]), [
  ["shown", "After the fix", "show_image"],
  ["compare", "Before and after", "compare_images"],
  ["shown", "half", "compare_images"],
  ["shown", "Checkout flow", "Attach"],
]);
assert.equal(p[0].at, 5);

const n = lookedNotes(events, (t) => t === "The answer");
assert.equal(n.get(0), "The **button** overlaps.");
assert.equal(n.get(2), "The **button** overlaps.");
assert.equal(n.has(8), false);    // shown, not looked at
assert.equal(n.has(12), false);   // only the answer came after
assert.equal(noteLine("a `b`\n**c**"), "a b c");
assert.equal(noteLine("x".repeat(400)).length, 280);

assert.deepEqual([...answerImages("![a](shots/p.png) `![no](q.png)` ![r](https://x/y.png) ![s](<a b.png>)")].sort(), ["a b.png", "p.png"]);
assert.deepEqual(withoutAnswered(p, "see ![p](./p.png)").map((x) => x.key), [p[1].key, p[2].key, p[3].key]);
assert.equal(withoutAnswered(p, "no pictures"), p);
assert.equal(withoutAnswered(p, "![b](b.png)").length, 4);   // half a comparison stays whole
assert.equal(withoutAnswered(p, "![b](b.png) ![c](c.png)").length, 3);
console.log("pictures.check: ok");
