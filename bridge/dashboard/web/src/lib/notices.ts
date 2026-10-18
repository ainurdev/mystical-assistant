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

const SOURCE: Record<Filter, string | null> = { all: null, needs: "", sessions: "session", rivendell: "rivendell", prs: "pr" };
export function matches(f: Filter, r: Notice): boolean {
  return f === "all" || SOURCE[f] === r.source;
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
