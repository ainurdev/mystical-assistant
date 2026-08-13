// Run: node --experimental-strip-types src/lib/scrollmem.check.ts  (from web/)
import { anchorAt, put, type Store } from "./scrollmem.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

// Three turns, as a virtualizer reports them.
const rows = [
  { key: "t1", start: 0, end: 100 },
  { key: "t2", start: 100, end: 300 },
  { key: "t3", start: 300, end: 900 },
];

ok(JSON.stringify(anchorAt(rows, 0)) === '{"turn":"t1","off":0}', "the top of the list anchors to the first turn");
ok(JSON.stringify(anchorAt(rows, 150)) === '{"turn":"t2","off":50}', "mid-turn keeps how far into it you were");
// The row you're inside is the one still on screen — 300 is t3's first pixel,
// so t2 (which ends there) is behind you.
ok(JSON.stringify(anchorAt(rows, 300)) === '{"turn":"t3","off":0}', "a boundary belongs to the turn below it");
// Scrolled past everything rendered (a shrink, a switch mid-measure): there's
// no row to name, and a wrong anchor is worse than none.
ok(anchorAt(rows, 1000) === null, "past the last row there's nothing to remember");
ok(anchorAt([], 0) === null, "an empty list remembers nothing");

// The store is a recency list: re-remembering a session moves it to the end,
// and only the oldest fall off the front.
const seq = ["a", "b", "c"].reduce<Store>((s, id) => put(s, id, "bottom", 3), {});
ok(Object.keys(put(seq, "a", { turn: "t9", off: 4 }, 3)).join() === "b,c,a", "re-remembering moves a session to newest");
ok(JSON.stringify(put(seq, "a", { turn: "t9", off: 4 }, 3).a) === '{"turn":"t9","off":4}', "…and replaces its anchor");
ok(Object.keys(put(seq, "d", "bottom", 3)).join() === "b,c,d", "past the cap the oldest session is dropped");
ok(Object.keys(put({}, "a", "bottom", 3)).join() === "a", "the first session fits");

console.log("scrollmem.check passed");
