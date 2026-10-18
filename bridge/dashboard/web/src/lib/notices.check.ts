// Run: node bridge/dashboard/web/src/lib/notices.check.ts
import type { Need, Notice, NoticePrefs } from "../api.ts";
import { ago, badge, cardFor, chipCount, freshSince, groupBySubject, isQuiet, matches, needMatches, popFor, safeUrl, sectionOf, stamp } from "./notices.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const n = (id: number, subject: string, o: Partial<Notice> = {}): Notice => ({
  id, at: 1000 + id, kind: "done", verb: "DONE", group: "done", tier: "news", source: "session",
  subject, title: "t", body: "", meta: {}, read: false, ...o,
});

// One row per subject: the newest, with how many came before it. NEEDS rows are
// live state (the needs list), never history.
const rows = groupBySubject([n(5, "a"), n(4, "b", { tier: "needs", kind: "approve" }), n(3, "a"), n(2, "b"), n(1, "a")]);
ok(rows.map((r) => `${r.id}:${r.earlier}`).join() === "5:2,2:0", "newest per subject, earlier counted, needs rows left out");

const day = new Date(2026, 9, 16, 17, 37);
ok(sectionOf(new Date(2026, 9, 16, 0, 5).getTime() / 1000, day) === "TODAY", "after midnight today is TODAY");
ok(sectionOf(new Date(2026, 9, 15, 23, 59).getTime() / 1000, day) === "EARLIER", "yesterday is EARLIER");
const st = (d: Date) => JSON.stringify(stamp(d.getTime() / 1000, day));
ok(st(new Date(2026, 9, 16, 9, 5)) === '{"day":"TODAY","time":"09:05"}', "the changelog stamps today with the time of day");
ok(st(new Date(2026, 9, 15, 23, 59)) === '{"day":"OCT 15","time":"23:59"}', "and an earlier day with its date");

ok(matches("all", n(1, "a")) && matches("sessions", n(1, "a")) && !matches("rivendell", n(1, "a")), "a session row is All and Sessions");
ok(matches("rivendell", n(1, "rv:p:1", { source: "rivendell" })), "a Rivendell row is Rivendell");
ok(matches("prs", n(1, "pr:o/r:x", { source: "pr" })) && !matches("needs", n(1, "a")), "PRs; Needs you lists only needs");
const offer: Need = { subject: "rv:p:1", kind: "rv_offer", verb: "OFFERED", title: "x", body: "", at: 1, session_id: null, meta: {} };
const card: Need = { ...offer, subject: "s1", kind: "approve", session_id: "s1" };
ok(needMatches("rivendell", offer) && !needMatches("sessions", offer) && needMatches("needs", offer), "an offer is Rivendell's");
ok(needMatches("sessions", card) && !needMatches("rivendell", card) && !needMatches("prs", card), "a card is the session's");

// A chip counts what waits on you plus unread news; rows you read stay listed, uncounted.
const mixed = [n(1, "a"), n(2, "b", { read: true }), n(3, "rv:p:1", { source: "rivendell" })];
ok(chipCount("all", [offer, card], mixed) === 4 && chipCount("sessions", [card], mixed) === 2 && chipCount("rivendell", [offer], mixed) === 2
  && chipCount("needs", [offer, card], mixed) === 2, "chips count needs plus unread, never read rows");

ok(badge(2, 5, true).kind === "count" && badge(2, 5, true).n === 2, "a number only when something waits on you");
ok(badge(0, 5, true).kind === "dot", "unread news is a dot, even in quiet hours");
ok(badge(0, 0, true).kind === "moon" && badge(0, 0, false).kind === null, "the moon when quiet, nothing otherwise");

const q = { on: true, from: "22:00", to: "09:00", needs: true };
const at = (h: number, m: number) => new Date(2026, 9, 16, h, m);
ok(isQuiet(q, at(23, 30)) && isQuiet(q, at(8, 59)) && !isQuiet(q, at(9, 0)) && !isQuiet(q, at(14, 0)), "quiet spans midnight");
ok(isQuiet({ ...q, from: "13:00", to: "15:00" }, at(14, 0)) && !isQuiet({ ...q, on: false }, at(23, 30)), "a daytime window, and off");

const feed = [n(9, "a"), n(8, "b"), n(7, "c")];
ok(freshSince(feed, 7).map((r) => r.id).join() === "8,9", "only rows past the cursor, oldest first");
ok(freshSince(feed, 9).length === 0, "a reload with the stored cursor pops nothing again");

const prefs: NoticePrefs = {
  events: { done: { pop: true, sound: "chime", tg: "away" }, ask: { pop: true, sound: "ping", tg: "away" },
            started: { pop: false, sound: "none", tg: "off" } },
  quiet: q, away_min: 5,
};
const env = { openSession: "a", visible: true, prefs, quiet: false };
ok(popFor(n(1, "a"), env) === null, "the session you're looking at never pops");
ok(JSON.stringify(popFor(n(1, "a"), { ...env, visible: false })) === '{"pop":true,"sound":"chime"}', "hidden window: it pops");
ok(JSON.stringify(popFor(n(1, "z"), env)) === '{"pop":true,"sound":"chime"}', "another session pops with its group's tone");
ok(popFor(n(1, "z", { group: "started", kind: "started" }), env) === null, "a group with no pop and no sound is silent");
ok(popFor(n(1, "z"), { ...env, quiet: true }) === null, "quiet hours hold news");
const ask = n(2, "z", { tier: "needs", kind: "approve", group: "ask" });
ok(popFor(ask, { ...env, quiet: true })?.sound === "ping", "a NEEDS YOU gets through quiet hours");
ok(popFor(ask, { ...env, quiet: true, prefs: { ...prefs, quiet: { ...q, needs: false } } }) === null, "unless you said not even that");
ok(popFor(n(3, "z", { group: "nonsense" }), env) === null, "an unknown group is silent, not a crash");
ok(popFor(n(4, "z", { kind: "failed", group: "done", meta: { quiet: true } }), env) === null, "an ask's own echo stays in the bell");

// A tab reopened after hours: a NEEDS row pops only if it still waits on you,
// or is a few seconds old (the needs poll may not have landed yet).
const stale = n(4, "z", { tier: "needs", kind: "approve", group: "ask", at: 1000 });
ok(popFor(stale, { ...env, live: new Set(), now: 1000 + 3600 }) === null, "an answered card from an hour ago stays in the bell");
ok(popFor(stale, { ...env, live: new Set(["z"]), now: 1000 + 3600 })?.pop === true, "one that still waits pops");
ok(popFor(stale, { ...env, live: new Set(), now: 1000 + 5 })?.pop === true, "a brand-new one pops before the needs poll lands");
ok(popFor(n(5, "y"), { ...env, live: new Set(), now: 99999 })?.pop === true, "news is not a need: liveness doesn't hold it");

ok(safeUrl("https://github.com/o/r/pull/9") === "https://github.com/o/r/pull/9" && safeUrl("http://x.test/a") === "http://x.test/a", "http(s) links open");
ok(safeUrl("javascript:alert(1)") === null && safeUrl(" JAVASCRIPT:x") === null && safeUrl("") === null && safeUrl(undefined) === null, "anything else never reaches window.open");

const pend = [{ request_id: "r1", kind: "permission" as const }, { request_id: "r2", kind: "permission" as const }];
ok(cardFor(pend, "r2") === pend[1] && cardFor(pend, "r9") === undefined && cardFor(pend, "") === undefined && cardFor(undefined, "r1") === undefined,
  "a button answers the card its row shows, or there is no button");

const now = 10_000_000;
ok(ago(now - 20, now) === "now" && ago(now - 120, now) === "2m" && ago(now - 3 * 3600, now) === "3h", "now / minutes / hours");
ok(ago(now - 30 * 3600, now) === "yest." && ago(now - 3 * 86400, now) === "3d", "yesterday and days");

console.log("\nall notices checks passed");
