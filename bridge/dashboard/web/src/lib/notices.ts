import type { Need, Notice, NoticePrefs, PendingCard } from "../api";
import type { ToneKey } from "./push";

/** The bell's pure half (components/hud/Notifications.tsx draws it). The feed
 *  is the bridge's (bridge/notices.py): rows arrive newest first, NEEDS YOU
 *  arrives separately as live state on /local/running, and the copy (`verb`) is
 *  the bridge's too, so the dashboard and the Mac menu bar say the same word. */

export type Filter = "all" | "needs" | "sessions" | "rivendell" | "prs";

/** A subject's newest notice, and how many came before it this week. */
export interface Row extends Notice { earlier: number }

/** One row per subject. NEEDS rows are left out: what waits on you is the live
 *  list, and an answered card isn't history worth a row. */
export function groupBySubject(rows: Notice[]): Row[] {
  const out: Row[] = [];
  const at = new Map<string, Row>();
  for (const r of rows) {
    if (r.tier === "needs") continue;
    const seen = at.get(r.subject);
    if (seen) seen.earlier++;
    else { const row = { ...r, earlier: 0 }; at.set(r.subject, row); out.push(row); }
  }
  return out;
}

export function sectionOf(at: number, now: Date): "TODAY" | "EARLIER" {
  return new Date(at * 1000).toDateString() === now.toDateString() ? "TODAY" : "EARLIER";
}

/** The changelog's dates: a record, so a day and a time of day ("TODAY", "16:38";
 *  "OCT 16", "10:05") where the bell's "2h" would keep ageing. */
export function stamp(at: number, now: Date): { day: string; time: string } {
  const d = new Date(at * 1000);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = sectionOf(at, now) === "TODAY" ? "TODAY" : d.toLocaleDateString("en", { month: "short", day: "numeric" }).toUpperCase();
  return { day, time };
}

const SOURCE: Record<Filter, string | null> = { all: null, needs: "", sessions: "session", rivendell: "rivendell", prs: "pr" };
export function matches(f: Filter, r: Notice): boolean {
  // What teammates send comes through Rivendell, so its filter shows it.
  return f === "all" || SOURCE[f] === r.source || (f === "rivendell" && r.source === "team");
}
export function needMatches(f: Filter, n: Need): boolean {
  const src = n.kind === "rv_offer" ? "rivendell" : "session";
  return f === "all" || f === "needs" || SOURCE[f] === src;
}

/** A chip's count: what waits on you plus unread news. Rows you read stay
 *  listed under it, uncounted — the number is a to-do, not a tally. */
export function chipCount(f: Filter, needs: Need[], rows: Notice[]): number {
  if (f === "needs") return needs.length;
  return needs.filter((x) => needMatches(f, x)).length + rows.filter((r) => !r.read && matches(f, r)).length;
}

/** A peach count only for what waits on you; a dot for unread news; the moon
 *  when quiet hours hold everything else. */
export function badge(needs: number, unread: number, quiet: boolean): { kind: "count" | "dot" | "moon" | null; n: number } {
  if (needs > 0) return { kind: "count", n: needs };
  if (unread > 0) return { kind: "dot", n: unread };
  return { kind: quiet ? "moon" : null, n: 0 };
}

/** bridge/notices.py quiet(), for the pop-ups and sounds this page plays. */
export function isQuiet(q: NoticePrefs["quiet"], d: Date): boolean {
  if (!q.on) return false;
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return q.from <= q.to ? q.from <= t && t < q.to : t >= q.from || t < q.to;
}

/** Rows past the cursor, oldest first — what is news since this page last looked. */
export function freshSince(rows: Notice[], cursor: number): Notice[] {
  return rows.filter((r) => r.id > cursor).sort((a, b) => a.id - b.id);
}

/** Whether a fresh notice interrupts, and with which tone. Null: it only lands
 *  in the bell — it's about the session you're looking at, its group neither
 *  pops nor sounds, quiet hours hold it, or it is a NEEDS row that no longer
 *  waits (`live`: the needs list's subjects; a tab reopened after hours would
 *  otherwise re-raise every card answered meanwhile). */
export function popFor(n: Notice, o: { openSession: string | null; visible: boolean; prefs: NoticePrefs; quiet: boolean;
  live?: Set<string>; now?: number }): { pop: boolean; sound: ToneKey | null } | null {
  if (o.visible && n.subject === o.openSession) return null;
  if (n.meta.quiet) return null;   // an ask's own echo (notices.echo): the ask already knocked
  // 30 s of grace: the needs list rides another poll and may not have it yet.
  if (n.tier === "needs" && o.live && !o.live.has(n.subject) && (o.now ?? 0) - n.at > 30) return null;
  const route = o.prefs.events[n.group];
  if (!route) return null;
  if (o.quiet && !(n.tier === "needs" && o.prefs.quiet.needs)) return null;
  const sound = route.sound === "none" ? null : route.sound;
  return route.pop || sound ? { pop: route.pop, sound } : null;
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return s < 2 * 86400 ? "yest." : `${Math.floor(s / 86400)}d`;
}

/** The card a NEEDS row is about: its own request, never just the first one
 *  pending — a job can hold two, and Allow must answer the one it shows. */
export function cardFor(pending: PendingCard[] | undefined, requestId: string): PendingCard | undefined {
  return requestId ? pending?.find((p) => p.request_id === requestId) : undefined;
}

/** Links in rows come from teammates and GitHub; only http(s) ever reaches window.open. */
export function safeUrl(u: unknown): string | null {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

/** The maintainers' notes an update waiting upstream carries (bridge/whatsnew.py
 *  preview, `meta.notes`), shaped or dropped: a row's meta is free JSON. */
export function notesOf(n: Notice): { heading: string; title: string; body: string; author: string }[] {
  const raw = Array.isArray(n.meta.notes) ? n.meta.notes : [];
  return raw.flatMap((x) => {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    return s("title") ? [{ heading: s("heading") || s("title"), title: s("title"), body: s("body"), author: s("author") }] : [];
  });
}

// ---- the changelog's reader (components/hud/ChangelogButton.tsx) ----------------------

/** A changelog day: TODAY, YESTERDAY, then the date ("OCT 22"). */
export function dayOf(at: number, now: Date): string {
  const d = new Date(at * 1000);
  const back = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  return back === 0 ? "TODAY" : back === 1 ? "YESTERDAY" : d.toLocaleDateString("en", { month: "short", day: "numeric" }).toUpperCase();
}

/** Rows (newest first, as they arrive) under their days. */
export function byDay<T extends { at: number }>(rows: T[], now: Date): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = [];
  for (const r of rows) {
    const day = dayOf(r.at, now);
    if (out.at(-1)?.day === day) out.at(-1)!.rows.push(r);
    else out.push({ day, rows: [r] });
  }
  return out;
}

const commitsOf = (n: Notice) => (typeof n.meta.commits === "number" ? n.meta.commits : 0);

/** Commits per day over the last 7 days, oldest first: the header's bars, today last. */
export function weekBars(rows: Notice[], now: Date): number[] {
  const start = new Date(now).setHours(0, 0, 0, 0) / 1000 - 6 * 86400;
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    const i = Math.floor((r.at - start) / 86400);
    if (r.kind === "updated" && i >= 0 && i < 7) out[i] += commitsOf(r);
  }
  return out;
}

/** A spine node's size from its update's commits: 1 (≤3), 2 (≤12), 3 (more). */
export function nodeSize(n: Notice): 1 | 2 | 3 {
  const c = commitsOf(n);
  return c <= 3 ? 1 : c <= 12 ? 2 : 3;
}

/** A bullet as [lead, text], split at its first " — "; no lead, [""", line]. */
export function leadOf(line: string): [string, string] {
  const at = line.indexOf(" — ");
  return at > 0 ? [line.slice(0, at), line.slice(at + 3)] : ["", line];
}

/** Find: the rows whose title or text holds q, any case. */
export function findIn(rows: Notice[], q: string): Notice[] {
  const k = q.trim().toLowerCase();
  return k ? rows.filter((r) => `${r.title}\n${r.body}`.toLowerCase().includes(k)) : rows;
}

export type FeatIcon = "send" | "panel" | "gauge" | "layers" | "flame" | "trees" | "users" | "image" | "palette" | "down" | "spark";
const ICONS: [RegExp, FeatIcon][] = [
  [/telegram|\bbot\b/, "send"], [/sidebar|\brail\b|panel/, "panel"], [/usage|limit/, "gauge"],
  [/work zone|\bzones?\b|tall(y|ies)/, "layers"], [/clone|install|update|pull/, "down"],
  [/middle-earth|theme|colou?r|\blook\b/, "palette"], [/dashboard|khazad|scene|intro|loading|gandalf|boot/, "flame"],
  [/rivendell|task|board/, "trees"], [/team|thread|shar|seen|teammate/, "users"], [/logo|picture|image|icon|background/, "image"],
];
/** The icon a feature gets from its lead; a spark when nothing fits. */
export function iconFor(lead: string): FeatIcon {
  const l = lead.toLowerCase();
  return ICONS.find(([re]) => re.test(l))?.[1] ?? "spark";
}

/** bridge/whatsnew.py PLACES: where Open › goes, and what its tooltip names. */
export const PLACES: Record<string, string> = {
  "settings:appearance": "Settings ▸ Appearance", "settings:transcript": "Settings ▸ Transcript",
  "settings:notifications": "Settings ▸ Notify", "settings:projects": "Settings ▸ Projects",
  "settings:aimgmt": "Settings ▸ AI management", "settings:integrations": "Settings ▸ Integrations",
  "settings:system": "Settings ▸ System", "settings:move": "Settings ▸ Move",
  "rail:files": "the FILES tab", "rail:git": "the GIT tab", "rail:rivendell": "the RIVENDELL tab",
  "rail:team": "the TEAM tab", "rail:usage": "the USAGE tab",
};
/** Each bullet's place, in bullet order; null where it has none. A row's meta is free JSON. */
export function placesOf(n: Notice): (string | null)[] {
  const go = Array.isArray(n.meta.go) ? n.meta.go : [];
  return n.body.split("\n").filter(Boolean).map((_, i) => (typeof go[i] === "string" && go[i] in PLACES ? (go[i] as string) : null));
}

/** An update as markdown, for Copy notes: the headline and its day, the bullets, the rest. */
export function notesMarkdown(n: Notice, now: Date): string {
  const day = new Date(n.at * 1000).toLocaleDateString("en", { month: "short", day: "numeric" });
  const lines = n.body.split("\n").filter(Boolean).map((l) => {
    const [lead, text] = leadOf(l);
    return lead ? `- **${lead}** — ${text}` : `- ${text}`;
  });
  const rest = typeof n.meta.rest === "number" && n.meta.rest > 0 ? n.meta.rest : 0;
  const url = safeUrl(n.meta.url);
  const tail = [rest ? `+${rest} smaller fix${rest === 1 ? "" : "es"}` : "", commitsOf(n) ? `${commitsOf(n)} commits${url ? `: ${url}` : ""}` : ""].filter(Boolean);
  return [`**${n.title}** · ${dayOf(n.at, now) === "TODAY" ? "today" : day}`, ...lines, ...(tail.length ? ["", tail.join(" · ")] : [])].join("\n");
}

/** Ask Claude about it: the prompt a new session in Mystical's own checkout starts with. */
export function askPrompt(n: Notice): string {
  const d = new Date(n.at * 1000);
  const when = `${d.toLocaleDateString("en", { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const from = typeof n.meta.from === "string" ? n.meta.from.slice(0, 7) : "";
  const to = typeof n.meta.to === "string" ? n.meta.to.slice(0, 7) : "";
  const range = from && to ? ` (\`git log ${from}..${to}\`)` : "";
  return `Tell me about this Mystical update from ${when}${range}:\n\n**${n.title}**\n`
    + n.body.split("\n").filter(Boolean).map((l) => `- ${l}`).join("\n")
    + `\n\nFor each change: what it does, where it lives in the code, and how I use it.`;
}
