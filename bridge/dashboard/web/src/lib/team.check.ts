// Run: node --experimental-strip-types src/lib/team.check.ts  (from web/)
//
// TEAM as the dashboard draws it: which sessions are someone else's, the roster's
// presence line and order, how far a share you sent got, and a card's facts.
// Things that go wrong quietly: a session a teammate sent left writable, a device
// run no longer read only, "since" shown for a day long gone, someone who never
// linked Mystical shown as "last on Jan 1, 1970", and a share that never arrived
// reading DELIVERED.
import type { Received, Share, Teammate } from "../api.ts";
import { byPresence, foldSent, isTeam, personTint, presence, readOnly, relationLine, seen, sentBefore, sentStatus, shareFacts, size } from "./team.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const now = Date.parse("2026-10-19T21:00:00") / 1000;
const iso = (secAgo: number) => new Date((now - secAgo) * 1000).toISOString();

ok(isTeam("team:prod") && !isTeam("teammate") && !isTeam(null), "isTeam reads only team:<instance>");
ok(readOnly("team:prod") && readOnly("device-run:prod"), "a teammate's share and device run are read only");
ok(!readOnly("dashboard") && !readOnly("rivendell:prod") && !readOnly(undefined), "your own sessions aren't");

ok(presence({ online: true, lastSeenAt: iso(3600) }, now, false).startsWith("on now · since "), "on today: since when");
eq(presence({ online: true, lastSeenAt: iso(3 * 86400) }, now), "on now", "on since days ago: no stale time");
eq(presence({ online: false, lastSeenAt: null }, now), "no Mystical linked yet", "never linked");
eq(presence({ online: false, lastSeenAt: "garbage" }, now), "no Mystical linked yet", "an unreadable time is never 1970");
eq(presence({ online: false, lastSeenAt: iso(30) }, now), "last on just now", "seconds ago");
eq(presence({ online: false, lastSeenAt: iso(41 * 60) }, now), "last on 41m ago", "minutes ago");
ok(presence({ online: false, lastSeenAt: iso(5 * 3600) }, now, false).startsWith("last on today, "), "earlier today");
ok(presence({ online: false, lastSeenAt: iso(26 * 3600) }, now, false).startsWith("last on yesterday, "), "yesterday");

const t = (name: string, online: boolean) => ({ id: name, name, avatarUrl: null, online, lastSeenAt: null, device: null }) as Teammate;
eq([t("Payam", false), t("Mahdi", true), t("Erfan", true)].sort(byPresence).map((x) => x.name),
  ["Erfan", "Mahdi", "Payam"], "who's on first, then by name");
ok(personTint("u-1") === personTint("u-1") && personTint("u-1").startsWith("var(--"), "a person's colour is stable");

const none = { deliveredAt: null, openedAt: null, continuedAt: null, dismissedAt: null };
eq(sentStatus(none, now), { text: "WAITING", tone: "warn" }, "not delivered yet waits");
eq(sentStatus({ ...none, deliveredAt: iso(10) }, now), { text: "DELIVERED", tone: "dim" }, "delivered");
eq(sentStatus({ ...none, deliveredAt: iso(9000), openedAt: iso(7200) }, now), { text: "OPENED 2H", tone: "ok" }, "opened 2h ago");
eq(sentStatus({ ...none, openedAt: iso(5), continuedAt: iso(1) }, now), { text: "CONTINUED", tone: "purple" }, "continued wins");

eq(shareFacts("session", { repo: "ainurhq/rivendell", branch: "main", turns: 1, pictures: 4, code: true }),
  { project: "rivendell", branch: "main", bits: ["1 turn", "4 pictures", "code"] }, "a session's facts");
eq(shareFacts("session", { project: "/ainurhq/apex", turns: 3 }), { project: "apex", bits: ["3 turns"] }, "no repo: the folder");
eq(shareFacts("file", { bytes: 1887436 }), { bits: ["1.8 MB"] }, "a file's size");
eq(shareFacts("session", { turns: 2, pictures: 100, pictures_total: 148 }), { bits: ["2 turns", "100 of 148 pictures"] }, "a bitten cap says how many there were");
eq([size(512), size(4096), size(-1), size("x")], ["512 B", "4 KB", "", ""], "sizes");

// SENT TO YOU keeps a share until you open or continue it; SEEN (and the rail's count) take it after.
ok(!seen({ opened: false, continued: false }), "a share nobody touched is new");
ok(seen({ opened: true, continued: false }), "opened, it's seen");
ok(seen({ opened: false, continued: true }), "continued straight from its card, it's seen too");

// Threads (bridge/team.py): a session sent to someone again shows once in YOU SENT, the
// send sheet knows what they have, a send waiting for its turn says so, and a card in a
// thread you have says what's new against what.
const out = (id: string, to: string, thread: string, secAgo: number, st: Partial<Share> = {}): Share => ({
  id, kind: "session", title: "t", note: null, meta: thread ? { thread, turns: 4, pictures: 1 } : {}, from: { id: "me", name: "Me" },
  to: { id: to, name: to }, sentAt: iso(secAgo), deliveredAt: null, openedAt: null, continuedAt: null, dismissedAt: null,
  expiresAt: null, ...st,
});
const rows = [out("q1", "erfan", "", 10, { queued: true }), out("b", "erfan", "t1", 60), out("a", "erfan", "t1", 3600),
  out("c", "mahdi", "t1", 7200), out("old", "erfan", "", 9000), out("old2", "erfan", "", 9500)];
eq(foldSent(rows).map((s) => s.id), ["q1", "b", "c", "old", "old2"], "YOU SENT folds a resend to the same person, keeps the rest");
eq(sentBefore(rows, "t1", "erfan")?.last.id, "b", "what they have is your newest send of that thread to them");
eq(sentBefore(rows, "t1", "erfan")?.count, 2, "and how many sends that was");
eq(sentBefore(rows, "t1", "payam"), null, "never sent to them");
eq(sentBefore(rows, undefined, "erfan"), null, "an older bridge's preview has no thread");
eq(sentStatus({ ...rows[0] }, now), { text: "AFTER ITS TURN", tone: "warn" }, "a send waiting for its turn");
eq(sentStatus({ ...rows[0], error: "Rivendell can't be reached right now." }, now), { text: "NOT SENT", tone: "err" }, "and one that failed");

const card = (r: Partial<Received>) => ({ relation: null, version: 1, new_turns: 2, prev: null, from: { id: "e", name: "Erfan Besharat" }, ...r });
eq(relationLine(card({ relation: "back", new_turns: 3 }), now, out("x", "e", "t", 5 * 3600)),
  { strong: "3 turns on top of yours", rest: " · you sent it to Erfan 5h ago" }, "sent back: their turns on top of yours");
eq(relationLine(card({ relation: "back", new_turns: 1 }), now), { strong: "1 turn on top of yours", rest: "" }, "sent back, the send itself out of reach");
eq(relationLine(card({ relation: "update", version: 2, new_turns: 3, prev: { state: "continued", at: now - 3600, version: 1 } }), now, null, false),
  { strong: "+3 turns since v1", rest: `, which you continued at ${new Date((now - 3600) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` },
  "an update to one you continued today");
eq(relationLine(card({ relation: "update", version: 3, new_turns: 1, prev: { state: "opened", at: now - 60, version: 2 } }), now),
  { strong: "+1 turn since v2", rest: ", which you opened" }, "an update to one you only opened");
eq(relationLine(card({ relation: "update", version: 1, new_turns: 2 }), now), { strong: "+2 turns since yours", rest: "" },
  "someone else's send in a thread you have");
eq(relationLine(card({}), now), null, "no thread you have: no line");
eq(relationLine(card({ relation: "update", version: 3, new_turns: 4, prev: { state: "continued", at: now - 60, version: 1 } }), now)?.strong,
  "+4 turns since v1", "counted from the version you saw, not one that folded in unseen");
