// Run: node --experimental-strip-types src/lib/team.check.ts  (from web/)
//
// TEAM as the dashboard draws it: which sessions are someone else's, the roster's
// presence line and order, how far a share you sent got, and a card's facts.
// Things that go wrong quietly: a session a teammate sent left writable, a device
// run no longer read only, "since" shown for a day long gone, someone who never
// linked Mystical shown as "last on Jan 1, 1970", and a share that never arrived
// reading DELIVERED.
import type { Teammate } from "../api.ts";
import { byPresence, isTeam, personTint, presence, readOnly, sentStatus, shareFacts, size } from "./team.ts";

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
eq([size(512), size(4096), size(-1), size("x")], ["512 B", "4 KB", "", ""], "sizes");
