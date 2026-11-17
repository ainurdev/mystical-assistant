// Run: node --experimental-strip-types src/lib/sessionfolds.check.ts  (from web/)
//
// The SESSION tab's folds: the list card opens one row at a time, the window and
// the turns fold on their own, and "fold all" shuts everything but the turns.
import { OPEN0, anyOpen, flipFold, foldAll, readFolds } from "./sessionfolds.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(OPEN0.turns && !OPEN0.window && !OPEN0.flows, "a fresh tab: turns open, every other section folded");

const t = flipFold(OPEN0, "time");
ok(t.time && !t.flows, "opening TIME opens it");
const h = flipFold(t, "helpers");
ok(h.helpers && !h.time, "opening HELPERS folds TIME: one list row at a time");
ok(!flipFold(h, "helpers").helpers, "a second click folds it again");

const w = flipFold(h, "window");
ok(w.window && w.helpers, "the window opens beside a list row");
ok(!flipFold(w, "turns").turns && flipFold(w, "turns").helpers, "the turns fold on their own, the list row stays");

const shut = foldAll(w);
ok(!shut.window && !shut.helpers && shut.turns, "fold all shuts the window and the list, keeps the turns");
ok(anyOpen(w) && !anyOpen(shut), "anyOpen sees the window or a list row, not the turns");

ok(readFolds('{"flows":true,"time":true}').flows && !readFolds('{"flows":true,"time":true}').time,
  "a stored set with two list rows open (before the list card) keeps only the first");
ok(readFolds('{"window":true}').turns, "a stored set from before the turns folded keeps them open");
ok(readFolds("not json").turns && !readFolds("not json").window, "a broken store reads as a fresh tab");
