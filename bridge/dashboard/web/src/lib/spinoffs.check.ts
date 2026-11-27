// Run: node bridge/dashboard/web/src/lib/spinoffs.check.ts
// The Spin-off card's arithmetic: which rows start ticked, what the counts say, how keys shorten.
import type { SpinRow } from "../api.ts";
import { counts, gone, placeCount, shortKeys, sourceCount, spinCardsOf, tickedAtFirst } from "./spinoffs.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const row = (n: number, over: Partial<SpinRow> = {}): SpinRow => ({
  n, title: `t${n}`, brief: "", flow: "fix", sources: [], after: 0, project: "/shop", clone: "",
  state: "open", session: "", note: "", repeat: null, ...over,
});
const REP = { project: "/efas", task: "w3", session: "s9", title: "Fix it", at: 1 };

eq(spinCardsOf([{ type: "text" }, { type: "spinoffs", card: "c2" }, { type: "result" }, { type: "spinoffs", card: "c2" }, { type: "spinoffs", card: "c3" }]),
  ["c2", "c3"], "a turn's cards, once each, in order");

ok(tickedAtFirst(row(1)), "a placed open row starts ticked");
ok(!tickedAtFirst(row(2, { project: "", clone: "https://github.com/me/web" })), "a row with no checkout starts unticked: START never clones by itself");
ok(!tickedAtFirst(row(3, { repeat: REP })), "a repeat has no tick");
ok(!tickedAtFirst(row(4, { project: "" })), "a row nobody could place waits for your pick");
ok(gone(row(5, { state: "waiting" })) && gone(row(6, { state: "parked" })) && !gone(row(7, { state: "failed" })),
  "started, waiting and parked rows fold to chips; a failed one stays to be tried again");

const place = (r: SpinRow) => r.project || (r.clone ? "clone" : "");
const rows = [row(1), row(2, { project: "/riv" }), row(3, { project: "", clone: "https://github.com/me/web" }), row(4, { project: "" }), row(5, { repeat: REP })];
eq(counts(rows, new Set([1, 2, 3, 4, 5]), place), { start: 3, park: 2 },
  "START takes the clone, PARK can't, and neither takes a row with no project or a repeat");
eq(placeCount(rows, place), 3, "projects: /shop, /riv and the repo to clone");

eq(shortKeys(["RIVENDELL-4Q2", "RIVENDELL-4Q5", "RIVENDELL-4Q9"]), ["RIVENDELL-4Q2", "4Q5", "4Q9"], "shared prefixes drop after the first key");
eq(shortKeys(["ELVOU-WEB-9K", "ELVOU-WEB-9M", "SHOP-1"]), ["ELVOU-WEB-9K", "9M", "SHOP-1"], "a key from elsewhere keeps its prefix");
eq(shortKeys(["#12", "#14"]), ["#12", "#14"], "keys with no dash stay whole");

eq(sourceCount([{ kind: "sentry", ref: "A-1", url: "" }, { kind: "sentry", ref: "A-2", url: "" }]), "2 issues", "tracker sources are issues");
eq(sourceCount([{ kind: "notes", ref: "", url: "https://x" }]), "1 source", "anything else is a source");
eq(sourceCount([]), "", "a row from no source says nothing");
