// Run: node src/lib/deck.check.ts  (from web/)
//
// The Rivendell deck's order. Quiet breakages: a skip that never expires (a task
// buried for good), and a skip that is ignored.
import { deck, liveSkips } from "./deck.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const t = (id: string, mine = false) => ({ id, name: id, mine, run: null, implementation: null });
const ids = (l: { id: string }[]) => l.map((x) => x.id).join();
const NOW = 1_000_000_000_000, H = 3_600_000;
const open = [t("a"), t("b", true), t("c"), t("d", true)];

ok(ids(deck(open, [], {}, NOW)) === "b,d,a,c", "no todolist: mine, then team");
ok(ids(deck(open, ["c", "a"], {}, NOW)) === "c,a,b,d", "next-up ids first, in their order, then the rest");
ok(ids(deck(open, ["zz", "c"], {}, NOW)) === "c,b,d,a", "an id that is not open is ignored");
ok(ids(deck(open, ["c", "a"], { c: NOW - H }, NOW)) === "a,b,d,c", "a 1h-old skip moves that task last");
const st = { sig: "c,a", at: { c: NOW - H, d: NOW - 25 * H } };
ok(JSON.stringify(liveSkips(st, "c,a", NOW)) === JSON.stringify({ c: NOW - H }), "same order: a fresh skip holds, a 25h one drops");
ok(JSON.stringify(liveSkips(st, "a,c", NOW)) === "{}", "the todolist changed order: skips are ignored");
ok(JSON.stringify(liveSkips(null, "", NOW)) === "{}", "nothing stored");
ok(ids(deck(open, ["c", "a"], { c: NOW - 25 * H }, NOW)) === "c,a,b,d", "a 25h-old skip is ignored");
