// Run: node bridge/dashboard/web/src/lib/almanac.check.ts
// The Almanac's arithmetic: the month grid and its ISO weeks, the weekly limit
// resets on it, the world clocks, and the time-zone search.
import type { AccountInfo } from "../api.ts";
import { atWork, fmtOffset, isoWeek, matchZones, monthGrid, placeName, resetDays, resetEvents, shortLogin, sunArc, whenLabel, workBand, zoneCity, zoneMinutes, zoneList, zoneTag, zoneTime } from "./almanac.ts";

// Every local-time answer below is Yerevan's (UTC+4 all year, no daylight saving).
process.env.TZ = "Asia/Yerevan";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// November 2026 starts on a Sunday: the grid opens on Monday 26 October, week 44.
const nov = monthGrid(2026, 10);
eq(nov.map((w) => w.week), [44, 45, 46, 47, 48, 49], "Nov 2026: six rows, ISO weeks 44-49");
eq(nov.map((w) => w.days.length), [7, 7, 7, 7, 7, 7], "Nov 2026: seven days a row");
eq([ymd(nov[0].days[0]), ymd(nov[0].days[6]), ymd(nov[5].days[6])], ["2026-10-26", "2026-11-1", "2026-12-6"], "Nov 2026: Monday first, runs into December");

// February 2027 fills exactly four rows; the grid still draws six, so the box never changes height.
const feb = monthGrid(2027, 1);
eq([feb.length, ymd(feb[0].days[0]), ymd(feb[5].days[6])], [6, "2027-2-1", "2027-3-14"], "Feb 2027: four full weeks, still six rows");

// 2026 is a 53-week year (1 January was a Thursday).
eq([isoWeek(new Date(2026, 11, 31)), isoWeek(new Date(2027, 0, 3)), isoWeek(new Date(2027, 0, 4))], [53, 53, 1], "week 53 runs into 2027");
eq(monthGrid(2027, 0)[0].week, 53, "Jan 2027 opens on week 53");
eq(isoWeek(new Date(2026, 0, 1)), 1, "1 Jan 2026 (a Thursday) is week 1");

// Each login's weekly reset lands on its local day: 21:30 UTC is already the
// next morning in Yerevan. A switched-off login and a meter that won't read mark nothing.
const login = (slot: number, alias: string, weekly: string | null, disabled = false) => ({
  slot, alias, email: null, disabled, five_hour: null,
  seven_day: weekly ? { percent: 40, resets_at: weekly, severity: "normal" } : null,
}) as unknown as AccountInfo;
eq(resetDays([
  login(2, "work", "2026-11-12T05:00:00Z"),
  login(3, "home", "2026-11-12T21:30:00Z"),
  login(4, "old", "2026-11-10T05:00:00Z", true),
  login(5, "", null),
]), { "2026-11-12": [2], "2026-11-13": [3] }, "weekly resets: by local day, per login slot");
eq(resetDays([login(2, "work", "2026-11-12T05:00:00Z"), login(3, "home", "2026-11-12T06:00:00Z")]),
  { "2026-11-12": [2, 3] }, "weekly resets: two logins on one day");

// World clocks against Yerevan (UTC+4). November: Amsterdam is on CET (+1) since
// 25 Oct, New York on EST (-5) since 1 Nov; in July New York is on EDT (-4).
const noonZ = Date.UTC(2026, 10, 6, 12, 0);
const pick = (z: string, at: number, h12 = false) => { const t = zoneTime(z, at, h12); return [t.time, t.ampm, t.shift, t.offset]; };
eq(pick("Europe/Amsterdam", noonZ), ["13:00", "", 0, -180], "Amsterdam: 3h behind");
eq(pick("America/New_York", noonZ), ["07:00", "", 0, -540], "New York in November: 9h behind");
eq(pick("Asia/Kolkata", noonZ), ["17:30", "", 0, 90], "Kolkata: half-hour zone");
eq(pick("Pacific/Kiritimati", noonZ), ["02:00", "", 1, 600], "Kiritimati: already tomorrow");
eq(pick("America/New_York", Date.UTC(2026, 10, 6, 2, 0)), ["21:00", "", -1, -540], "New York: still yesterday");
eq(pick("America/New_York", Date.UTC(2026, 6, 1, 12, 0)), ["08:00", "", 0, -480], "New York in July: daylight saving");
eq(pick("Europe/Amsterdam", noonZ, true), ["1:00", "PM", 0, -180], "12-hour spelling");
eq([-180, 90, 0, -570, 600].map(fmtOffset), ["\u22123h", "+1h30", "same time", "\u22129h30", "+10h"], "offsets as people say them");
eq(["Europe/Amsterdam", "America/New_York", "America/Argentina/Buenos_Aires", "UTC"].map(zoneCity),
  ["Amsterdam", "New York", "Buenos Aires", "UTC"], "a zone's city");
eq(["Europe/Amsterdam", "America/New_York", "America/Argentina/Buenos_Aires", "UTC"].map(zoneTag),
  ["AMS", "NY", "BA", "UTC"], "a zone's header tag");

// The zone search: by city first, then by region or any word, then anywhere.
const ZONES = ["America/Argentina/Buenos_Aires", "America/New_York", "Asia/Yerevan", "Europe/Amsterdam", "Europe/Andorra", "Europe/London", "UTC"];
eq(matchZones("york", ZONES), ["America/New_York"], "search: a city's second word");
eq(matchZones("New Y", ZONES), ["America/New_York"], "search: spaces for underscores, any case");
eq(matchZones("europe", ZONES), ["Europe/Amsterdam", "Europe/Andorra", "Europe/London"], "search: a region");
eq(matchZones("an", ZONES), ["Europe/Andorra", "Asia/Yerevan"], "search: a city that starts with it beats one that only contains it");
eq([matchZones("", ZONES), matchZones("a", ZONES, 3).length], [[], 3], "search: nothing typed, nothing listed; capped");
ok(zoneList().includes("UTC") && zoneList().includes("Europe/Amsterdam"), "this engine's zone list, with UTC");

// The bridge stores the weather place in capitals; it reads as a name, the country code kept.
eq(["YEREVAN, YEREVAN, AM", "SAN FRANCISCO", "AMSTERDAM, NORTH HOLLAND, NL", "SAINT-ÉTIENNE, AUVERGNE-RHÔNE-ALPES, FR"].map(placeName),
  ["Yerevan, Yerevan, AM", "San Francisco", "Amsterdam, North Holland, NL", "Saint-Étienne, Auvergne-Rhône-Alpes, FR"], "a stored place as a name");
eq(placeName("McAllen, Texas, US"), "McAllen, Texas, US", "a place already in its own case stays as it is");

// NEXT UP: every reset across the logins, soonest first. A 5-hour window with no reset
// time (or one already past) has nothing to wait for: it folds into "ready".
const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-11-06T14:20:00Z");   // Fri 18:20 in Yerevan
const acct = (slot: number, email: string, five: string | null | undefined, weekly: string | null, more: object = {}) => ({
  slot, alias: null, email, disabled: false, logged_in: true,
  five_hour: five === undefined ? null : { percent: 10, resets_at: five, severity: "normal" },
  seven_day: weekly ? { percent: 40, resets_at: weekly, severity: "normal" } : null, ...more,
}) as unknown as AccountInfo;
const r = resetEvents([
  acct(2, "mhzrerfani@gmail.com", null, "2026-11-11T11:59:00Z"),
  acct(3, "hello@ainurhq.cloud", "2026-11-06T09:00:00Z", "2026-11-13T02:00:00Z"),
  acct(4, "ai@unideck.app", "2026-11-06T19:11:00Z", "2026-11-12T02:59:00Z"),
  acct(5, "old@x.io", null, "2026-11-08T00:00:00Z", { disabled: true }),
  acct(6, "gone@x.io", undefined, null, { logged_in: false }),
], NOW);
eq(r.events.map((e) => [e.slot, e.kind]), [[4, "5-hour"], [2, "weekly"], [4, "weekly"], [3, "weekly"]], "next up: soonest first, switched-off logins left out");
eq([r.ready, r.out], [[2, 3], [6]], "next up: idle 5-hour windows are ready; a signed-out login is named apart");
// The usage API leaves the 5-hour bucket out while no 5-hour window runs; the weekly one still reads.
const idle = resetEvents([acct(8, "idle@x.io", undefined, "2026-11-12T02:59:00Z"), acct(9, "blind@x.io", undefined, null)], NOW);
eq([idle.ready, idle.blind], [[8], [9]], "next up: no 5-hour bucket beside a readable week is ready; a meter that reads nothing is named apart");
eq([whenLabel(at("2026-11-06T19:11:00Z"), NOW), whenLabel(at("2026-11-11T11:59:00Z"), NOW), whenLabel(at("2026-11-11T11:59:00Z"), NOW, true)],
  ["in 4h51m", "Wed 15:59", "Wed 3:59 PM"], "when: a countdown inside a day, a weekday and time past it");
eq(["mhzrerfani@gmail.com", "ai@unideck.app"].map((e, i) => shortLogin(acct(i, e, null, null))), ["mhzrerfani", "ai"], "a login by the name before @");
eq(shortLogin({ ...acct(7, "x@y.z", null, null), alias: "work" } as AccountInfo), "work", "a login's alias wins");

// OVERLAP: a city's 09-18 laid on your own 24 hours (Yerevan here), split where it wraps midnight.
eq([-180, -540, 90, 600, 0].map(workBand), [[[12, 21]], [[18, 24], [0, 3]], [[7.5, 16.5]], [[23, 24], [0, 8]], [[9, 18]]],
  "work band: Amsterdam, New York (wraps), Kolkata (half hour), Kiritimati (wraps the other way), home");
eq([atWork("Europe/Amsterdam", noonZ), atWork("America/New_York", noonZ), atWork("America/New_York", Date.UTC(2026, 10, 6, 15, 20)),
    atWork("Europe/Amsterdam", Date.UTC(2026, 10, 7, 12, 0))], [true, false, true, false], "at work: weekday 09-18 on their clock, not Saturday");

// SUN ARC: where the sun is on today's path, sunrise 07:37 to sunset 17:54 (10h 17m), on the place's clock.
const arc = (m: number) => { const a = sunArc("07:37", "17:54", m); return [Math.round(a.f * 1000) / 1000, a.up, a.daylight, a.caption]; };
eq(arc(12 * 60), [0.426, true, "10h 17m", "the sun sets in 5h 54m"], "sun: midday, on its way down");
eq(arc(18 * 60 + 20), [1, false, "10h 17m", "the sun set 26 min ago"], "sun: just set");
eq(arc(5 * 60), [0, false, "10h 17m", "the sun rises in 2h 37m"], "sun: before dawn");
eq(arc(23 * 60), [1, false, "10h 17m", "night · sunrise 07:37"], "sun: deep night");
eq([zoneMinutes("Asia/Yerevan", noonZ), zoneMinutes("Europe/Amsterdam", noonZ), zoneMinutes(undefined, noonZ)], [960, 780, 960], "minutes past midnight on a zone's clock");
