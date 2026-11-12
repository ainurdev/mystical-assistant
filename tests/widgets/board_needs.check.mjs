// The Live board's Needs-you row and its quiet state with the last two turns
// (ticket telegram-widgets 04).
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { check, load } from "./harness.mjs";

const AT = 1794300000;                   // 08:40 UTC
const board = (rows, extra = {}) => ({ v: 1, at: AT, rows, ...extra });
const R = { k: "a1b2c3d4", c: "r", t: "widgets grill", s: "reading bridge/tglive.py", a: AT - 252, n: "12.4k" };
const N = { k: "c3d4e5f6", c: "n", t: "pr review flow", s: "which layout? · 3 options", a: AT - 130, v: "asks" };

check("a needs-you row: verb, what is asked, and how long it has waited", () => {
  const p = load("board.html", board([R, N]));
  assert.match(p.text(), /P pr review flow asks: which layout\? · 3 options 2m$/);
  assert.match(p.html(), /<span class="v">asks:<\/span>/);
  p.tick(3600);
  assert.match(p.text(), /3 options 1h$/);
});

check("a needs-you row with no known wait shows no time", () => {
  const { a, ...noWait } = N;
  assert.match(load("board.html", board([noWait])).text(), /3 options$/);
});

check("quiet: Nothing is running, then the last two turns, how each ended and when", () => {
  const last = [{ t: "widgets grill", s: "done · 6 min", a: AT - 600, ok: 1 },
                { t: "rivendell team tab", s: "failed · tests", a: AT - 1800 }];
  const p = load("board.html", board([], { last }));
  assert.match(p.text(), /Nothing is running\. ✓ widgets grill done · 6 min 8:30 ! rivendell team tab failed · tests 8:10$/);
  assert.match(p.html(), /linear-gradient\(#a0de7e,#54cb68\)">✓/);
  assert.match(p.html(), /linear-gradient\(#ff885e,#ff516a\)">!/);
});

check("quiet with no turns ended yet is only the line", () => {
  assert.match(load("board.html", board([])).text(), /Nothing is running\.$/);
});
