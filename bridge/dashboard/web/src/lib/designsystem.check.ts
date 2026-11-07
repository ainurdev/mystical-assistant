// node --experimental-strip-types src/lib/designsystem.check.ts
import assert from "node:assert/strict";
import { contrast, FEELS, mix, onAccent, PAIRS, sampleDoc, warnings, type Spec } from "./designsystem.ts";

assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
assert.equal(contrast("#fff", "#ffffff"), 1);
assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
assert.equal(onAccent("#d7f03a"), "#000000");
assert.equal(onAccent("#8c1c13"), "#ffffff");
assert.deepEqual(warnings({ accent: "#000000", ground: "#ffffff", ink: "#000000", muted: "#555555" }), []);
assert.equal(warnings({ accent: "#ffffff", ground: "#ffffff", ink: "#bbbbbb", muted: "#cccccc" }).length, 3);
// Every starting point it offers has to pass its own checks.
for (const [name, p] of Object.entries(FEELS)) {
  assert.deepEqual(warnings(p), [], name);
  assert.ok(PAIRS.some((x) => x.id === p.pair), name);
}
const spec: Spec = { ...FEELS.Calm, name: "<b>x</b>", about: "", feel: [], avoid: "", heading: "a", body: "b", size: 16 };
assert.match(sampleDoc(spec), /&lt;b&gt;x&lt;\/b&gt;/);
assert.match(sampleDoc(spec), /fonts\.googleapis\.com\/css2\?family=Fraunces/);
console.log("designsystem ok");
