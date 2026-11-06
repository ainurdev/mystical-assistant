/** The Almanac's arithmetic (components/hud/Almanac.tsx, the Clock's drop-down).
 *
 *  Pure on purpose: dates go in, rows and labels come out, so almanac.check.ts
 *  can pin the edges (week 53, months that need six rows, daylight saving)
 *  without a browser. Weeks start on Monday and carry ISO numbers, the way the
 *  weekly report (bridge/report.py) already counts them. */
import type { AccountInfo } from "../api.ts";
import { span } from "./limit.ts";

/** A local day as a key: "2026-11-06". */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** ISO 8601 week number: weeks start on Monday, week 1 holds the year's first Thursday. */
export function isoWeek(d: Date): number {
  // The Thursday of d's week decides its year; count weeks from that year's 1 January.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

/** A month as the calendar draws it: always six Monday-first rows, so stepping
 *  to another month never resizes the box, each row with its ISO week. Days are
 *  local midnights, built from y/m/d rather than by adding 24h, which would
 *  drift an hour across a daylight-saving change. */
export function monthGrid(year: number, month: number): { week: number; days: Date[] }[] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // days shown from the month before
  return Array.from({ length: 6 }, (_, r) => {
    const days = Array.from({ length: 7 }, (_, c) => new Date(year, month, 1 - lead + r * 7 + c));
    return { week: isoWeek(days[0]), days };
  });
}

/** Which logins' weekly window refills on which local day, by slot: {"2026-11-12": [2]}.
 *  A switched-off login, or one whose meter won't read, marks nothing. */
export function resetDays(accounts: AccountInfo[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const a of accounts) {
    const t = new Date((!a.disabled && a.seven_day?.resets_at) || NaN);
    if (!isNaN(t.getTime())) (out[dayKey(t)] ??= []).push(a.slot);
  }
  return out;
}

/** A login as the Almanac names it, short enough for a row: its alias, else the
 *  name before the @ (the full address goes in the row's title). */
export const shortLogin = (a: AccountInfo) => a.alias || a.email?.split("@")[0] || `account ${a.slot}`;

export interface ResetEvent { at: number; slot: number; kind: "5-hour" | "weekly" }

/** NEXT UP: every reset across the logins, soonest first. A 5-hour window with no
 *  reset time, or one already past, has nothing to wait for and lands in `ready`,
 *  and so does a login whose meter reads its week but has no 5-hour bucket (the
 *  usage API leaves it out while no window runs). A signed-out login lands in
 *  `out`, one whose meter reads neither window in `blind`, a switched-off one nowhere. */
export function resetEvents(accounts: AccountInfo[], now: number): { events: ResetEvent[]; ready: number[]; out: number[]; blind: number[] } {
  const events: ResetEvent[] = [], ready: number[] = [], out: number[] = [], blind: number[] = [];
  for (const a of accounts) {
    if (a.disabled) continue;
    if (a.logged_in === false) { out.push(a.slot); continue; }
    if (!a.five_hour && !a.seven_day) { blind.push(a.slot); continue; }
    const five = new Date(a.five_hour?.resets_at ?? NaN).getTime();
    if (five > now) events.push({ at: five, slot: a.slot, kind: "5-hour" });
    else if (a.five_hour || a.seven_day) ready.push(a.slot);
    const wk = new Date(a.seven_day?.resets_at ?? NaN).getTime();
    if (wk > now) events.push({ at: wk, slot: a.slot, kind: "weekly" });
  }
  return { events: events.sort((x, y) => x.at - y.at), ready, out, blind };
}

/** When a reset lands: a countdown inside a day ("in 4h51m"), else its weekday and time. */
export function whenLabel(at: number, now: number, h12 = false): string {
  const left = Math.max(0, Math.round((at - now) / 60_000));
  if (left < 1440) return `in ${left >= 60 ? `${Math.floor(left / 60)}h${String(left % 60).padStart(2, "0")}m` : `${left}m`}`;
  const d = new Date(at), h = d.getHours(), mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${h12 ? `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}` : `${String(h).padStart(2, "0")}:${mm}`}`;
}

/** A zone's wall clock at an instant, read back as if it were UTC, so two zones
 *  subtract to their offset. `undefined` is this browser's own zone. */
function wall(zone: string | undefined, at: number): number {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(at)) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** A world clock at an instant: its time ("13:00", or "1:00" + "PM"), the day
 *  it is there against here (-1 yesterday, 1 tomorrow) and how far it is ahead
 *  of this browser's zone, in minutes. Intl does the daylight-saving rules. */
export function zoneTime(zone: string, at: number, h12 = false): { time: string; ampm: string; shift: number; offset: number } {
  const there = wall(zone, at), here = wall(undefined, at);
  const d = new Date(there);
  const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, "0");
  return {
    time: h12 ? `${h % 12 || 12}:${m}` : `${String(h).padStart(2, "0")}:${m}`,
    ampm: h12 ? (h < 12 ? "AM" : "PM") : "",
    shift: Math.floor(there / 86_400_000) - Math.floor(here / 86_400_000),
    offset: Math.round((there - here) / 60_000),
  };
}

/** An offset as people say it: "−3h", "+1h30", "same time". */
export function fmtOffset(min: number): string {
  if (!min) return "same time";
  const a = Math.abs(min);
  return `${min < 0 ? "−" : "+"}${Math.floor(a / 60)}h${a % 60 ? String(a % 60).padStart(2, "0") : ""}`;
}

/** A zone's city: "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export const zoneCity = (zone: string) => zone.split("/").pop()!.replace(/_/g, " ");

/** The short tag a pinned world clock wears in the header: one word gives its
 *  first three letters (AMS), more give their initials (NY, BA). */
export function zoneTag(zone: string): string {
  const w = zoneCity(zone).split(" ").filter(Boolean);
  return (w.length > 1 ? w.map((x) => x[0]).join("") : w[0].slice(0, 3)).toUpperCase();
}

/** Every time zone this browser knows, plus UTC, which some engines leave out. */
export function zoneList(): string[] {
  const all = Intl.supportedValuesOf("timeZone");
  return all.includes("UTC") ? all : [...all, "UTC"];
}

/** Zones matching what was typed, best first: the city starts with it, then a
 *  region or another word does, then it shows up anywhere. "new y" finds
 *  America/New_York. */
export function matchZones(q: string, zones: string[], max = 8): string[] {
  const t = q.trim().toLowerCase().replace(/[_/]+/g, " ");
  if (!t) return [];
  const rank = (z: string) => {
    const words = ` ${z.toLowerCase().replace(/[_/]+/g, " ")}`;
    return zoneCity(z).toLowerCase().startsWith(t) ? 0 : words.includes(` ${t}`) ? 1 : words.includes(t) ? 2 : 3;
  };
  return zones.map((z) => [rank(z), z] as const).filter(([r]) => r < 3)
    .sort((a, b) => a[0] - b[0]).slice(0, max).map(([, z]) => z);
}

/** The weather place as a name. Older bridges and the env default store it in
 *  capitals ("YEREVAN, YEREVAN, AM"): those parts become "Yerevan". A part already
 *  in its own case ("McAllen", from the city picker) stays as it is, and so does a
 *  last two-letter part, the country code. */
export function placeName(loc: string): string {
  const parts = loc.split(",").map((p) => p.trim());
  return parts.map((p, i) => ((i > 0 && i === parts.length - 1 && p.length === 2) || p !== p.toUpperCase() ? p
    : p.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase()))).join(", ");
}

/** OVERLAP: a city's 09–18 working day on your own 24 hours, as [from, to) hour
 *  spans; a day that wraps your midnight comes back as two. `offset` is how far
 *  the city is ahead of you, in minutes (zoneTime's).
 *  shortcut: every city works 09–18, Monday to Friday (here and in atWork); give a world clock its own hours if one doesn't. */
export function workBand(offset: number): [number, number][] {
  const from = (((9 - offset / 60) % 24) + 24) % 24, to = from + 9;
  return to <= 24 ? [[from, to]] : [[from, 24], [0, to - 24]];
}

/** Whether it's working hours in a zone: Monday to Friday, 09:00 to 18:00 on its own clock. */
export function atWork(zone: string, at: number): boolean {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(at);
  const day = p.find((x) => x.type === "weekday")?.value, h = Number(p.find((x) => x.type === "hour")?.value);
  return day !== "Sat" && day !== "Sun" && h >= 9 && h < 18;
}

/** Minutes past midnight on a zone's clock (`undefined`: this browser's). */
export function zoneMinutes(zone: string | undefined, at: number): number {
  const d = new Date(wall(zone, at));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** SUN ARC: where the sun is on today's path, as `f` from 0 (sunrise) to 1 (sunset),
 *  the daylight's length and a caption. `rise`/`set` are "HH:MM" and `now` minutes past
 *  midnight, all on the weather place's own clock.
 *  shortcut: after dark it names today's sunrise for tomorrow's, a minute or two off; fetch day two if that matters. */
export function sunArc(rise: string, set: string, now: number): { f: number; up: boolean; daylight: string; caption: string } {
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const r = min(rise), s = min(set);
  const dur = (m: number) => span(m * 60);
  const caption = now < r ? `the sun rises in ${dur(r - now)}`
    : now <= s ? `the sun sets in ${dur(s - now)}`
    : now - s < 60 ? `the sun set ${now - s} min ago` : `night · sunrise ${rise}`;
  return { f: Math.min(1, Math.max(0, (now - r) / (s - r))), up: now >= r && now <= s, daylight: dur(s - r), caption };
}
