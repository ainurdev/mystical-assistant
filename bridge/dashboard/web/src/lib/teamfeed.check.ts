// Run: node --experimental-strip-types src/lib/teamfeed.check.ts  (from web/)
//
// The Team tab's feed: a share waiting for you is a card, everything else one line;
// today and earlier; newest first. Things that go wrong quietly: a dismissed send
// still listed, an opened send still reading WAITING, a continued share shown as a card.
import type { Received, Share, TeamOverview } from "../api.ts";
import { teamFeed } from "./teamfeed.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const now = Date.parse("2026-11-05T21:00:00") / 1000;
const iso = (secAgo: number) => new Date((now - secAgo) * 1000).toISOString();
const rec = (o: Partial<Received>): Received => ({
  id: "r", kind: "session", title: "T", note: "", from: { id: "e", name: "Erfan" }, sent: iso(600), meta: {},
  session: "s", file: null, url: null, opened: false, continued: false, at: now - 600, ...o,
});
const snd = (o: Partial<Share>): Share => ({
  id: "s", kind: "session", title: "T", note: null, meta: {}, from: { id: "me", name: "Me" }, to: { id: "e", name: "Erfan" },
  sentAt: iso(600), deliveredAt: null, openedAt: null, continuedAt: null, dismissedAt: null, expiresAt: null, ...o,
});
const team = (o: Partial<TeamOverview>): TeamOverview => ({ roster: [], inbox: [], outbox: [], error: null, ...o });

const e = teamFeed(team({}), now);
ok(e.today.length === 0 && e.earlier.length === 0, "empty overview: both lists empty");

const f = teamFeed(team({
  inbox: [
    rec({ id: "new", title: "Apex fix" }),
    rec({ id: "old", title: "NR Kantoor Project Status · v2", from: { id: "m", name: "Mahdi" }, continued: true, at: now - 10 * 86400, sent: iso(10 * 86400) }),
  ],
  outbox: [
    snd({ id: "o1", title: "EFAS Pentest", openedAt: iso(10 * 86400), sentAt: iso(10 * 86400 + 60) }),
    snd({ id: "o2", title: "Gone", dismissedAt: iso(100) }),
  ],
}), now);
const c = f.today[0];
ok(c?.kind === "share" && c.r.id === "new", "an unopened inbox share is today's first card");
ok(f.today.length === 1, "continued old item and old send are not today");
const lines = f.earlier.filter((x) => x.kind === "line");
ok(lines.length === 2 && f.earlier.length === 2, "two earlier lines");
const sent = lines.find((x) => x.kind === "line" && x.icon === "send");
ok(sent?.kind === "line" && sent.status === "OPENED ✓✓" && sent.tone === "ok", "an opened send reads OPENED ✓✓, ok");
ok(sent?.kind === "line" && sent.text === "You sent EFAS Pentest to Erfan", "send line text");
const cont = lines.find((x) => x.kind === "line" && x.icon === "msg");
ok(cont?.kind === "line" && cont.text === "You continued Mahdi's NR Kantoor Project Status · v2", "continued item line text");
ok(!JSON.stringify(f).includes("Gone"), "a dismissed send is absent");
ok(f.earlier[0].at >= f.earlier[1].at, "newest first");

const q = teamFeed(team({ outbox: [snd({ id: "q1", queued: true, error: "no link" }), snd({ id: "q2", queued: true })] }), now).today;
const qe = q.find((x) => x.kind === "line" && x.id === "q1"), qw = q.find((x) => x.kind === "line" && x.id === "q2");
ok(qe?.kind === "line" && qe.status === "NOT SENT" && qe.tone === "err" && !!qe.tip?.includes("no link"), "a failed send keeps err tone and its reason");
ok(qw?.kind === "line" && qw.status === "AFTER ITS TURN" && qw.tone === "warn" && !!qw.tip, "a queued send keeps warn tone and its tip");

const w = teamFeed(team({ outbox: [snd({}), snd({ id: "d", deliveredAt: iso(500) })] }), now);
const st = w.today.map((x) => (x.kind === "line" ? x.status : ""));
ok(st.includes("WAITING") && st.includes("DELIVERED"), "WAITING and DELIVERED stay");
