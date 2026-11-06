// Run: node src/lib/deck.check.ts  (from web/)
//
// The Rivendell deck's order and its spec excerpt. Quiet breakages: a skip that
// never expires (a task buried for good), a skip that is ignored, and markdown
// marks leaking into the card's excerpt.
import { deck, excerpt } from "./deck.ts";

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
ok(ids(deck(open, ["c", "a"], { c: NOW - 25 * H }, NOW)) === "c,a,b,d", "a 25h-old skip is ignored");

ok(excerpt("## Why\n**p95** went from 380 ms…", 40) === "Why p95 went from 380 ms…", "markdown stripped, short text kept");
ok(excerpt("a [link](http://x.y) and `code`\n- item") === "a link and code item", "links, code, bullets");
const long = excerpt("word ".repeat(60), 40);
ok(long.endsWith("…") && long.length <= 41 && !long.includes("wor…"), "cut at a word with …");
ok(excerpt("") === "", "empty");
