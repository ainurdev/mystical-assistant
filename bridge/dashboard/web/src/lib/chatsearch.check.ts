import assert from "node:assert/strict";
import { hitWord, orderHits, snippetParts, stepHit } from "./chatsearch.ts";

const h = (turn: string, kind: string, seq: number | null) => ({ turn, kind, seq, snippet: "" });
assert.deepEqual(
  orderHits([h("b", "prompt", null), h("a", "text", 9), h("b", "result", 12), h("a", "prompt", null), h("z", "text", 1)], ["a", "b"]).map((x) => `${x.turn}${x.seq}`),
  ["anull", "a9", "bnull", "b12", "z1"],
);
// the answer's streamed copy is one hit with the answer
assert.deepEqual(
  orderHits([{ ...h("a", "text", 1), snippet: "same" }, { ...h("a", "result", 2), snippet: "same" }, { ...h("a", "text", 3), snippet: "other" }], ["a"]).map((x) => x.seq),
  [2, 3],
);
assert.equal(stepHit(-1, 3, 1), 0);
assert.equal(stepHit(-1, 3, -1), 2);
assert.equal(stepHit(2, 3, 1), 0);
assert.equal(stepHit(0, 3, -1), 2);
assert.equal(stepHit(-1, 0, 1), -1);
assert.deepEqual(snippetParts("Fix the fix", "FIX"), [{ t: "Fix", hit: true }, { t: " the ", hit: false }, { t: "fix", hit: true }]);
assert.deepEqual(snippetParts("abc", ""), [{ t: "abc", hit: false }]);
assert.deepEqual(snippetParts("abc", "zz"), [{ t: "abc", hit: false }]);
assert.equal(hitWord("prompt"), "You");
assert.equal(hitWord("result"), "Answer");
assert.equal(hitWord("text"), "Note");
console.log("chatsearch.check: ok");
