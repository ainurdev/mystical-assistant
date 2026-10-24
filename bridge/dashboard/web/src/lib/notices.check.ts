// Run: node bridge/dashboard/web/src/lib/notices.check.ts
import type { Need, Notice, NoticePrefs } from "../api.ts";
import { ago, askPrompt, badge, byDay, cardFor, chipCount, dayOf, findIn, freshSince, groupBySubject, iconFor, isQuiet, leadOf, matches, needMatches, nodeSize, notesMarkdown, notesOf, placesOf, popFor, safeUrl, sectionOf, stamp, weekBars } from "./notices.ts";

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

const waiting = n(9, "coming", { kind: "coming", meta: { notes: [{ heading: "h", title: "T", body: "b", author: "A" }, "junk", { body: "no title" }, { title: "Bare" }] } });
ok(JSON.stringify(notesOf(waiting)) === '[{"heading":"h","title":"T","body":"b","author":"A"},{"heading":"Bare","title":"Bare","body":"","author":""}]',
  "a waiting update's notes: shaped, a titleless one or junk dropped");
ok(notesOf(n(1, "a")).length === 0 && notesOf(n(2, "b", { meta: { notes: "x" } })).length === 0, "no notes, or not a list: none");


// ---- the changelog's reader -----------------------------------------------------------
{
  const now = new Date(2026, 9, 25, 0, 20);
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime() / 1000;
  ok(dayOf(at(25, 0, 8), now) === "TODAY" && dayOf(at(24, 23, 50), now) === "YESTERDAY" && dayOf(at(22, 20), now) === "OCT 22",
    "days read TODAY, YESTERDAY, then the date");
  const u = (id: number, a: number, o: Partial<Notice> = {}) => n(id, `update:${id}`, { at: a, kind: "updated", ...o });
  const rows = [u(4, at(25, 0, 8), { meta: { commits: 2 } }), u(3, at(24, 23, 50), { meta: { commits: 25 } }),
                u(2, at(22, 20), { meta: { commits: 13 } }), u(1, at(22, 12), { meta: { commits: 3 } }), u(0, at(12, 9), { meta: { commits: 9 } })];
  ok(JSON.stringify(byDay(rows, now).map((g) => [g.day, g.rows.map((r) => r.id)])) === '[["TODAY",[4]],["YESTERDAY",[3]],["OCT 22",[2,1]],["OCT 12",[0]]]',
    "rows fall under their days in order");
  ok(weekBars(rows, now).join() === "0,0,0,16,0,25,2", "the week's bars: commits per day, a fortnight ago left out, today last");
  ok(nodeSize(rows[0]) === 1 && nodeSize(rows[2]) === 3 && nodeSize(u(9, 0, { meta: { commits: 12 } })) === 2 && nodeSize(u(9, 0)) === 1,
    "a node grows with its commits");
  ok(leadOf("Usage — limits on the rail").join("|") === "Usage|limits on the rail" && leadOf("Two").join("|") === "|Two", "a bullet's lead");
  const t = [u(1, 1, { title: "Logo picker", body: "Logos — one tap" }), u(2, 2, { title: "Other", body: "Repo icons — without a LOGO" }), u(3, 3, { title: "x", body: "y" })];
  ok(findIn(t, " logo ").map((r) => r.id).join() === "1,2" && findIn(t, "").length === 3, "find matches titles and bullets, any case");
  ok(iconFor("Telegram") === "send" && iconFor("Sidebar") === "panel" && iconFor("Clone & install") === "down"
    && iconFor("Work zone") === "layers" && iconFor("Middle-earth") === "palette" && iconFor("Rivendell") === "trees" && iconFor("Mystery") === "spark",
    "a feature's icon comes from its lead, a spark when nothing fits");
  const g = u(5, 5, { body: "A — a\nB — b\nC — c", meta: { go: ["rail:usage", "nowhere", 7] } });
  ok(JSON.stringify(placesOf(g)) === '["rail:usage",null,null]' && placesOf(u(6, 6, { body: "A — a" }))[0] === null,
    "places only from the known list, in bullet order");
  const md = notesMarkdown(u(7, at(24, 23, 50), { title: "Usage on the rail", body: "Usage — limits\nPlain words",
    meta: { commits: 25, rest: 20, url: "https://github.com/o/r/compare/a...b" } }), now);
  ok(md === "**Usage on the rail** · Oct 24\n- **Usage** — limits\n- Plain words\n\n+20 smaller fixes · 25 commits: https://github.com/o/r/compare/a...b",
    "Copy notes writes markdown");
  const ask = askPrompt(u(8, at(24, 23, 50), { title: "Usage", body: "Usage — limits", meta: { from: "3e77cc8aa", to: "ab5fc19bb" } }));
  ok(ask.startsWith("Tell me about this Mystical update from Oct 24 23:50 (`git log 3e77cc8..ab5fc19`)") && ask.includes("- Usage — limits"),
    "Ask Claude carries the range and the notes");
}

console.log("\nall notices checks passed");
