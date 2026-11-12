// Stop a turn from a board row: ■, the Keep / Stop question, "Stopping…" and the
// answers (ticket telegram-widgets 05). Taps go through the page's tap(action, key).
import assert from "node:assert/strict";
import { check, load } from "./harness.mjs";

const AT = 1794300000;
const board = (rows) => ({ v: 1, at: AT, rows });
const R = { k: "a1b2c3d4", c: "r", t: "widgets grill", s: "reading bridge/tglive.py", a: AT - 252, n: "12.4k" };
const R2 = { k: "c3d4e5f6", c: "r", t: "rivendell team tab", s: "npm run check", a: AT - 63 };
const H = { k: "b2c3d4e5", c: "h", t: "pr review flow", s: "3 helpers working", a: AT - 63 };
const rowOf = (p, k) => p.html().split('<div class="li"').find((r) => r.includes(`data-k="${k}"`)) || "";
const flush = () => new Promise((ok) => setImmediate(ok));
// harness.check is synchronous; these await the request's promise.
const acheck = (name, fn) => fn().then(() => console.log(`ok   ${name}`),
  (e) => { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; });

check("a running row has a labelled ■ button; a helpers row has none", () => {
  const p = load("board.html", board([R, H]));
  assert.match(rowOf(p, R.k), /<span class="x" role="button" aria-label="Stop widgets grill" data-a="x" data-k="a1b2c3d4">■</);
  assert.ok(!rowOf(p, H.k).includes('data-a='));
});

check("■ opens Keep / Stop in the row, Keep restores it", () => {
  const p = load("board.html", board([R, R2]));
  const before = rowOf(p, R.k);
  p.ctx.tap("x", R.k);
  const q = rowOf(p, R.k);
  assert.match(q, /class="t" dir="auto">Stop widgets grill\?</);
  assert.match(q, /The work so far stays\./);
  assert.match(q, /class="b g" role="button" aria-label="Keep widgets grill" data-a="k"[^>]*>Keep</);
  assert.match(q, /class="b" role="button" aria-label="Stop widgets grill" data-a="s"[^>]*>Stop</);
  assert.match(q, /class="ic"[^>]*>W</, "the row keeps its icon, so it keeps its height");
  assert.ok(!q.includes("■") && !rowOf(p, R2.k).includes("Keep"));
  p.ctx.tap("k", R.k);
  assert.equal(rowOf(p, R.k), before);
  assert.equal(p.requests.length, 0);
});

check("a second ■ closes the first", () => {
  const p = load("board.html", board([R, R2]));
  p.ctx.tap("x", R.k);
  p.ctx.tap("x", R2.k);
  assert.ok(!rowOf(p, R.k).includes("Keep") && rowOf(p, R2.k).includes("Keep"));
});

check("new data keeps the question open while its row exists, and drops it when it goes", () => {
  const p = load("board.html", board([R, R2]));
  p.ctx.tap("x", R.k);
  p.data(board([{ ...R, s: "running tests" }, R2]));
  assert.ok(rowOf(p, R.k).includes("Keep"));
  p.data(board([R2]));
  p.data(board([R, R2]));                        // the same key back later: closed
  assert.ok(!rowOf(p, R.k).includes("Keep"));
});

await acheck("Stop sends exactly one request with the row's key and reads Stopping…", async () => {
  const p = load("board.html", board([R]));
  p.ctx.tap("x", R.k);
  p.ctx.tap("s", R.k);
  p.ctx.tap("s", R.k);                           // a double tap sends nothing more
  assert.deepEqual(p.requests.map((r) => r.text), ["s:a1b2c3d4"]);
  assert.match(p.text(), /widgets grill .* Stopping…$/);
  assert.ok(!p.html().includes("■"));
  p.requests[0].ok({ result: "ok" });
  await flush();
  p.data(board([{ ...R, s: "interrupting" }]));  // the look that follows: still on the board
  assert.match(p.text(), /Stopping…$/);
  p.data(board([]));                             // stopped: the row leaves
  assert.match(p.text(), /Nothing is running\.$/);
});

await acheck("Stopping… belongs to the turn: the session's next turn shows its ■ again", async () => {
  const p = load("board.html", board([R]));
  p.ctx.tap("x", R.k);
  p.ctx.tap("s", R.k);
  p.requests[0].ok({ result: "ok" });
  await flush();
  p.data(board([{ ...R, a: AT - 2 }]));          // a queued prompt started straight after
  assert.match(p.text(), /0:02 ■$/);
});

for (const [name, settle] of [
  ["an answer of gone", (r) => r.ok({ result: "gone" })],
  ["an answer of no", (r) => r.ok({ result: "no" })],
  ["a request that fails", (r) => r.no({ code: "TIMEOUT" })],
]) {
  await acheck(`${name} restores the row`, async () => {
    const p = load("board.html", board([R]));
    p.ctx.tap("x", R.k);
    p.ctx.tap("s", R.k);
    settle(p.requests[0]);
    await flush();
    assert.match(p.text(), /4:12 ■$/);
  });
}
