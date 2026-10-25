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

// ---- the changelog: one change at a time (components/hud/ChangelogButton.tsx,
// docs/superpowers/specs/changelog-v4.md) ------------------------------------------------

/** A changelog day: TODAY, YESTERDAY, then the date ("OCT 22"). */
export function dayOf(at: number, now: Date): string {
  const d = new Date(at * 1000);
  const back = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  return back === 0 ? "TODAY" : back === 1 ? "YESTERDAY" : d.toLocaleDateString("en", { month: "short", day: "numeric" }).toUpperCase();
}

/** The reader's time: "Today · 02:16", "Yesterday · 23:50", "Fri, Oct 24 · 23:50". */
export function whenOf(at: number, now: Date): string {
  const day = dayOf(at, now), { time } = stamp(at, now);
  return `${day === "TODAY" ? "Today" : day === "YESTERDAY" ? "Yesterday"
    : new Date(at * 1000).toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

/** A list row's time: today's time of day, an older day's date ("Oct 24"). */
export function shortWhen(at: number, now: Date): string {
  const { day, time } = stamp(at, now);
  return day === "TODAY" ? time : new Date(at * 1000).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** A bullet as [lead, text], split at its first " — "; no lead, [""", line]. */
export function leadOf(line: string): [string, string] {
  const at = line.indexOf(" — ");
  return at > 0 ? [line.slice(0, at), line.slice(at + 3)] : ["", line];
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

/** bridge/whatsnew.py PLACES: where Open › goes, and what its button names. */
export const PLACES: Record<string, string> = {
  "settings:appearance": "Settings ▸ Appearance", "settings:transcript": "Settings ▸ Transcript",
  "settings:notifications": "Settings ▸ Notify", "settings:projects": "Settings ▸ Projects",
  "settings:aimgmt": "Settings ▸ AI management", "settings:integrations": "Settings ▸ Integrations",
  "settings:system": "Settings ▸ System", "settings:move": "Settings ▸ Move",
  "rail:files": "the FILES tab", "rail:git": "the GIT tab", "rail:rivendell": "the RIVENDELL tab",
  "rail:team": "the TEAM tab", "rail:usage": "the USAGE tab",
};

/** A change note's picture (bridge/whatsnew.py MEDIA_NAME): a still, a clip, or a clip with its still. */
export type Media = { still: string | null; clip: string | null };
/** One change: an update's bullet (or a waiting update's) with its place, state and picture.
 *  `area` is the lead, or the bullet itself when it has none. */
export interface Change { id: string; row: Notice; area: string; text: string; place: string | null; when: string | null; media: Media | null }

const MEDIA_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.(webp|png|jpg|mp4)$/;
const named = (x: unknown) => (typeof x === "string" && MEDIA_NAME.test(x) ? x : null);
/** Served by /local/changelog/media: one file name, so a name that isn't one is no picture. */
export const mediaUrl = (name: string) => `/local/changelog/media/${name}`;

/** Rows (newest first) as changes. A row's meta is free JSON: go, when and media are
 *  columns aligned with its bullets, each kept only in the shape the bridge writes. */
export function changesOf(rows: Notice[]): Change[] {
  return rows.flatMap((r): Change[] => {
    const col = (k: string) => (Array.isArray(r.meta[k]) ? (r.meta[k] as unknown[]) : []);
    const go = col("go"), when = col("when"), media = col("media");
    return r.body.split("\n").filter(Boolean).map((line, i) => {
      const [lead, text] = leadOf(line);
      const m = media[i] && typeof media[i] === "object" ? (media[i] as Record<string, unknown>) : {};
      const pic = { still: named(m.still), clip: named(m.clip) };
      return { id: `${r.id}.${i}`, row: r, area: lead || text, text: lead ? text : "",
               place: typeof go[i] === "string" && (go[i] as string) in PLACES ? (go[i] as string) : null,
               when: typeof when[i] === "string" && when[i] ? (when[i] as string) : null,
               media: pic.still || pic.clip ? pic : null };
    });
  });
}

/** Find: the changes whose area or words hold q, any case. */
export function findChanges(list: Change[], q: string): Change[] {
  const k = q.trim().toLowerCase();
  return k ? list.filter((c) => `${c.area}\n${c.text}`.toLowerCase().includes(k)) : list;
}

/** The changes to one area, by its first word ("Usage", "Usage limits"), in list order. */
export function sameArea(list: Change[], c: Change): Change[] {
  const k = (x: Change) => x.area.toLowerCase().split(/\s+/)[0];
  return list.filter((x) => k(x) === k(c));
}

/** Ask Claude about it: the prompt a new session in Mystical's own checkout starts with. */
export function askChange(c: Change): string {
  const d = new Date(c.row.at * 1000);
  const when = `${d.toLocaleDateString("en", { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const from = typeof c.row.meta.from === "string" ? c.row.meta.from.slice(0, 7) : "";
  const to = typeof c.row.meta.to === "string" ? c.row.meta.to.slice(0, 7) : "";
  return `Tell me about this change to Mystical, from the update of ${when}${from && to ? ` (\`git log ${from}..${to}\`)` : ""}:\n\n`
    + `**${c.area}**${c.text ? ` — ${c.text}` : ""}\n\n`
    + `What it does, where it lives in the code, and how I use it${c.when ? ` (it shows when ${c.when})` : ""}.`;
}

/** A change as markdown, for Copy. */
export function changeMarkdown(c: Change): string {
  return `**${c.area}**${c.text ? ` — ${c.text}` : ""}${c.when ? `\n\n_Shows when ${c.when}._` : ""}`;
}
