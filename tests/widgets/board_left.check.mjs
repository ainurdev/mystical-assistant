// A board left behind (moved down the chat, or switched off) shows its one line:
// no rows, no ■, no footer (ticket telegram-widgets 06).
import assert from "node:assert/strict";
import { check, load } from "./harness.mjs";

const AT = 1794300000;
const R = { k: "a1b2c3d4", c: "r", t: "widgets grill", s: "reading", a: AT - 252, n: "12.4k" };

check("a moved board says so and nothing else", () => {
  assert.equal(load("board.html", { v: 1, at: AT, left: "moved" }).text(), "This board moved down the chat.");
});

check("a board switched off says so and nothing else", () => {
  assert.equal(load("board.html", { v: 1, at: AT, left: "off" }).text(), "The Live board is off.");
});

check("rows, a footer or a left-out count beside the mark are not drawn", () => {
  const p = load("board.html", { v: 1, at: AT, rows: [R], more: 3, u: { l: "x", w: [[42, AT, 0]] }, left: "moved" });
  assert.equal(p.text(), "This board moved down the chat.");
  assert.ok(!p.html().includes("■") && !p.html().includes('class="li"'));
});

check("new data that marks the board left redraws to the line", () => {
  const p = load("board.html", { v: 1, at: AT, rows: [R] });
  p.data({ v: 1, at: AT, left: "off" });
  assert.equal(p.text(), "The Live board is off.");
});
