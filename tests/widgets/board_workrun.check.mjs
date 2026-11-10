// A work run on its manager's row: the counts, an item in progress, "+N", and Keep /
// Stop sending the work-run request (ticket telegram-widgets 09).
import assert from "node:assert/strict";
import { check, load } from "./harness.mjs";

const AT = 1794300000;
const board = (rows) => ({ v: 1, at: AT, rows });
const W = { k: "a1b2c3d4", c: "w", t: "ship widgets", s: "Board stop row", a: AT - 600, p: [3, 7, 1] };

check("the row reads work run · D of T done · the item +N, timed from the run's start, with ■", () => {
  const p = load("board.html", board([W]));
  assert.match(p.text(), /ship widgets work run · 3 of 7 done · Board stop row \+1 10:00 ■$/);
  assert.match(p.html(), /role="button" aria-label="Stop ship widgets" data-a="x" data-k="a1b2c3d4">■</);
});

check("no +N when only one item is in progress", () => {
  const p = load("board.html", board([{ ...W, p: [3, 7, 0] }]));
  assert.match(p.text(), /done · Board stop row 10:00 ■$/);
});

check("no item in progress: no trailing separator", () => {
  const p = load("board.html", board([{ ...W, s: "", p: [3, 7, 0] }]));
  assert.match(p.text(), /work run · 3 of 7 done 10:00 ■$/);
});

check("Keep / Stop: Keep restores the row, Stop sends w:<key> and reads Stopping…", () => {
  const p = load("board.html", board([W]));
  const before = p.html();
  p.ctx.tap("x", W.k);
  assert.match(p.text(), /Stop ship widgets\? The work so far stays\. Keep Stop$/);
  p.ctx.tap("k", W.k);
  assert.equal(p.html(), before);
  p.ctx.tap("x", W.k);
  p.ctx.tap("s", W.k);
  assert.deepEqual(p.requests.map((r) => r.text), ["w:a1b2c3d4"]);
  assert.match(p.text(), /Stopping…$/);
});
