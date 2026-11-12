// The Live board's usage footer: both bars with percent and time to reset, the
// login when named, the page's warning colours, and no footer without a reading
// or on a board that shows only its one line (ticket telegram-widgets 07).
import assert from "node:assert/strict";
import { check, load } from "./harness.mjs";

const AT = 1794300000;
const R = { k: "a1b2c3d4", c: "r", t: "widgets grill", s: "Bash: ls", a: AT - 60 };
const U = { w: [[42, AT + 2 * 3600 + 14 * 60, 0], [61, AT + 3 * 86400 + 20 * 3600, 1]] };
const board = (extra = {}) => ({ v: 1, at: AT, rows: [R], ...extra });

check("both bars with their percent and time to reset, under the rows", () => {
  const p = load("board.html", board({ u: U }));
  assert.match(p.text(), /widgets grill .* 5h 42% ↻ 2h 14m week 61% ↻ 3d 20h$/);
  assert.match(p.html(), /width:42%;background:var\(--tg-theme-button-color\)/);
});

check("the reset counts down with the timer", () => {
  const p = load("board.html", board({ u: U }));
  p.tick(14 * 60);
  assert.match(p.text(), /5h 42% ↻ 2h 00m/);
});

check("warning is amber and exceeded red, on the bar and the percent", () => {
  const html = load("board.html", board({ u: { w: [[97, AT + 30, 2], [81, AT + 90, 1]] } })).html();
  assert.match(html, /width:97%;background:#e5484d.*color:#e5484d">97%/);
  assert.match(html, /width:81%;background:#f5a623.*color:#f5a623">81%/);
  assert.match(load("board.html", board({ u: { w: [[97, AT + 30, 2], null] } })).text(), /5h 97% ↻ now$/);
});

check("a bar past 100 stays inside its track; no reset known, no time", () => {
  const p = load("board.html", board({ u: { w: [[130, 0, 2], null] } }));
  assert.match(p.html(), /width:100%/);
  assert.match(p.text(), /5h 130%$/);
});

check("the login is named when the data names it, escaped, in its own direction", () => {
  assert.match(load("board.html", board({ u: { ...U, l: "<i>work</i>" } })).html(),
    /class="ul" dir="auto">&#60;i&#62;work&#60;\/i&#62;<\/div>/);
  assert.doesNotMatch(load("board.html", board({ u: U })).html(), /class="ul"/);
});

check("no reading, no footer; a quiet board still shows it", () => {
  assert.doesNotMatch(load("board.html", board()).html(), /class="u"/);
  assert.match(load("board.html", { v: 1, at: AT, rows: [], u: U }).text(), /Nothing is running\. 5h 42%/);
});

check("a board of an unknown version shows its one line and no footer", () => {
  assert.equal(load("board.html", { v: 99, at: AT, rows: [], u: U }).text(), "Send /status for a fresh board.");
});
