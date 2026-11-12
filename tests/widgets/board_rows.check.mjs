// The Live board's rows, its quiet line, the left-out count, the "updated" line
// and an unknown data version (ticket telegram-widgets 02).
import assert from "node:assert/strict";
import { check, load } from "./harness.mjs";

const AT = 1794300000;
const board = (rows, extra = {}) => ({ v: 1, at: AT, rows, ...extra });
const R = { k: "a1b2c3d4", c: "r", t: "widgets grill", s: "reading bridge/tglive.py", a: AT - 252, n: "12.4k" };
const H = { k: "b2c3d4e5", c: "h", t: "rivendell team tab", s: "3 helpers working", a: AT - 63 };

check("a running row: initial, title, step with tokens, and its time", () => {
  const p = load("board.html", board([R]));
  assert.match(p.html(), /class="ic"[^>]*>W</);
  assert.match(p.text(), /Live sessions just now W widgets grill reading bridge\/tglive\.py · 12\.4k 4:12/);
});

check("a helpers row says so, with no tokens", () => {
  const t = load("board.html", board([H])).text();
  assert.match(t, /rivendell team tab 3 helpers working 1:03/);
});

check("times count up with the timer, and the updated line ages", () => {
  const p = load("board.html", board([R]));
  p.tick(8);
  assert.match(p.text(), /8s ago .* 4:20/);
  p.tick(3600);
  assert.match(p.text(), /1h ago .* 1:04:20/);
});

check("+N more under the rows", () => {
  assert.match(load("board.html", board([R], { more: 5 })).text(), /\+5 more$/);
});

check("no rows: Nothing is running.", () => {
  assert.match(load("board.html", board([])).text(), /Live sessions just now Nothing is running\.$/);
});

check("new data redraws", () => {
  const p = load("board.html", board([R]));
  p.data(board([H]));
  assert.ok(!p.text().includes("widgets grill") && p.text().includes("rivendell team tab"));
});

check("titles and steps take their own direction, and are escaped", () => {
  const html = load("board.html", board([{ ...R, t: "<b>جلسه</b>" }])).html();
  assert.match(html, /class="t" dir="auto">&#60;b&#62;جلسه/);
  assert.match(html, /class="s" dir="auto">/);
});

check("an unknown data version, or none, asks for a fresh board", () => {
  assert.equal(load("board.html", { v: 99, at: AT, rows: [R] }).text(), "Send /status for a fresh board.");
  assert.equal(load("board.html", "not json").text(), "Send /status for a fresh board.");
});

check("a helpers row with no start shows no time", () => {
  const { a, ...noStart } = H;
  assert.match(load("board.html", board([noStart])).text(), /3 helpers working$/);
});
