// What Claude Code now says about itself, the way the dashboard tells it
// (design: .mystical/design-drafts/cli-signals, rows 1, 2, 3 and 7). Pure: the
// components draw, this only reads the status map, the turn's events and a
// login's meter.
//
// Row 1: a turn that answered while background tasks still run in its process
// (status `background`). Row 2: the CLI retrying a request (`retry` events) and
// a login running low. Row 3: how fresh a login's reading is. Row 7: the seam
// between a turn a bridge restart cut and the turn Claude Code carried it on in.
import type { AccountInfo, RunEvent, SessionStatus, TimedEvent } from "../api";
import type { Turn } from "../chat";
import type { Window } from "../models";
import { CONTINUED } from "./checkpoints.ts";

// --- row 1: background tasks --------------------------------------------------

/** What the pill and the chat's quiet line say about the tasks an answered turn
 *  left running: how many, the newest one's words, how far through the fan-out
 *  it is ((peak − live) / peak, so a run of six reads as progress), when the
 *  oldest started (the pill's age) and when the answer landed (the line's clock,
 *  as the working indicator it replaces counted the state). null for any other
 *  state, and for one with nothing listed. */
export function bgView(st?: SessionStatus | null):
  { n: number; desc: string; frac: number; oldest: number; since: number } | null {
  const tasks = st?.state === "background" ? st.bg ?? [] : [];
  if (!tasks.length) return null;
  const n = tasks.length, peak = Math.max(st?.peak ?? n, n);
  const newest = tasks.reduce((m, t) => (t.since > m.since ? t : m));
  const oldest = Math.min(...tasks.map((t) => t.since));
  return { n, desc: newest.desc, frac: (peak - n) / peak, oldest, since: st?.since ?? oldest };
}

// --- row 2: retries -----------------------------------------------------------

export type Retry = Extract<RunEvent, { type: "retry" }> & { at?: number };

/** The retry a running turn waits on: its last event is one. `since` is when
 *  that run of retries began, the live line's clock (undefined on events the
 *  store hasn't stamped). null once anything else lands, which means a try got
 *  through. */
export function retrying(events: readonly TimedEvent[]): { e: Retry; since?: number } | null {
  let i = events.length - 1;
  const last = events[i];
  if (last?.type !== "retry") return null;
  while (i > 0 && events[i - 1].type === "retry") i--;
  return { e: last, since: events[i].at };
}

/** How many times a turn's requests were retried: the WORK plate keeps it once
 *  the turn moves on. */
export const retries = (events: readonly TimedEvent[]) => events.filter((e) => e.type === "retry").length;

/** The CLI's error class (runner._retry_reason) in plain words. */
export function retryWhy(error: string): string {
  const e = (error || "").toLowerCase();
  if (e.includes("overload") || e === "http_529") return "API overloaded";
  if (e.includes("rate_limit") || e === "http_429") return "rate limited";
  if (e === "connection") return "no response";
  if (e.includes("server") || /^http_5\d\d$/.test(e)) return "server error";
  const http = /^http_(\d{3})$/.exec(e);
  return http ? `HTTP ${http[1]}` : e.replace(/_/g, " ") || "request failed";
}

/** The live line for a retry at `now` (epoch s): which try, why, when the next
 *  goes, and the share of the wait still to run (the countdown ring). A retry
 *  the store hasn't stamped counts its wait from `now`. */
export function retryLine(e: Retry, now: number): { what: string; note: string; left: number; frac: number } {
  const wait = Math.max(0, (e.delay_ms || 0) / 1000);
  const left = Math.max(0, Math.ceil((e.at ?? now) + wait - now));
  const why = retryWhy(e.error);
  return {
    what: e.max ? `try ${e.attempt} of ${e.max}` : `try ${e.attempt}`,
    note: left > 0 ? `${why} · next try in ${left} s` : `${why} · trying again`,
    left,
    frac: wait > 0 ? Math.min(1, left / wait) : 0,
  };
}

// --- rows 2 and 3: the meter --------------------------------------------------

const spent = (severity?: string) => severity === "exceeded" || severity === "critical";
const past = (severity?: string) => !!severity && severity !== "normal";

/** The % a meter prints in: red once a window is spent or the CLI refused,
 *  amber at the CLI's warning (a window's severity, or a turn's allowed_warning),
 *  else the accent. */
export function meterTone(left: number, severity?: string, status?: string | null): string {
  if (left <= 0 || spent(severity) || status === "rejected") return "var(--err)";
  return past(severity) || status === "allowed_warning" ? "var(--warn)" : "var(--acc)";
}

/** The window a running-low pill names: the tightest one the CLI marks past
 *  normal, or the tightest of all when a running turn said allowed_warning.
 *  null when nothing is low, and once a window is spent (the out pill says that). */
export function lowWindow(wins: readonly Window[], status?: string | null): Window | null {
  if (wins.some((w) => w.left <= 0)) return null;
  const low = wins.filter((w) => past(w.severity));
  const pool = low.length ? low : status === "allowed_warning" ? wins : [];
  return pool.reduce<Window | null>((a, w) => (a === null || w.left < a.left ? w : a), null);
}

/** "5-hour", "weekly": a window as the pill says it. */
export const windowWord = (w: Window) => (w.tag === "WK" ? "weekly" : "5-hour");

/** How long ago a meter was read, in the PROFILE menu's words. */
export function readAgo(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** How fresh a login's reading is, at the end of its meter line: live while a
 *  running turn reports it, checking while it has no reading yet or a read of
 *  it is in flight (`reading`: the menu's fresh=N, so a reading older than N s
 *  is being redone), else how long ago it was read. null for a switched-off
 *  login, whose meter isn't read. */
export function freshness(a: Pick<AccountInfo, "left" | "disabled" | "live" | "read_at">, now: number,
  reading: number | null): { k: "live" | "checking" | "ago"; text: string } | null {
  if (a.disabled) return null;
  if (a.live) return { k: "live", text: "live" };
  const at = a.read_at ?? null;
  if (a.left === null || at === null || (reading !== null && now - at >= reading))
    return { k: "checking", text: "checking" };
  return { k: "ago", text: readAgo(at, now) };
}

// --- row 7: the seam ----------------------------------------------------------

/** Claude Code won't carry on a turn cut longer ago than this. */
export const OLD_CUT = 6 * 3600;

/** When a turn last did anything: its last stamped event, else its outline's
 *  end (a turn behind the tail cut), else its start. */
function lastAt(t: Turn): number | null {
  for (let i = t.events.length - 1; i >= 0; i--) {
    const at = t.events[i].at;
    if (at != null) return at;
  }
  return t.sum?.ended ?? t.started ?? null;
}

/** The line that joins a turn a bridge restart cut (`cut`, the turn before) to
 *  the turn Claude Code carried it on in (`cont`, prompt CONTINUED):
 *  - picking: it runs and nothing has come back yet;
 *  - carried: it came back, `lag` seconds after the bridge restarted;
 *  - declined: Claude Code wouldn't (a `resume` declined event), or the run
 *    ended with nothing said. Then the time is the cut's, and `old` says it was
 *    cut more than OLD_CUT before.
 *  `lead` is followed by the clock of `at`, the component's to format. null for
 *  a turn that isn't a continuation. */
export function seamOf(cut: Turn | undefined, cont: Turn):
  { k: "picking" | "carried" | "declined"; at: number | null; lead: string; rest: string } | null {
  if (cont.prompt !== CONTINUED) return null;
  const restarted = cont.started ?? null;
  const said = cont.events.filter((e) => e.type !== "resume");
  const declined = cont.events.some((e) => e.type === "resume" && e.declined);
  if (declined || (!said.length && cont.status !== "running")) {
    const at = cut ? lastAt(cut) : null;
    const old = at !== null && restarted !== null && restarted - at > OLD_CUT;
    return { k: "declined", at: at ?? restarted, lead: "Cut by a bridge restart at",
             rest: old ? "too old for Claude Code to carry on (over 6 h)" : "Claude Code didn't pick it up" };
  }
  if (!said.length) return { k: "picking", at: restarted, lead: "Bridge restarted at", rest: "Claude Code is picking the turn back up…" };
  const first = said.find((e) => e.at != null)?.at;
  const lag = first != null && restarted !== null ? Math.max(0, Math.round(first - restarted)) : null;
  return { k: "carried", at: restarted, lead: "Bridge restarted at",
           rest: lag === null ? "Claude Code picked the turn up"
             : `Claude Code picked the turn up ${lag < 60 ? `${lag} s` : `${Math.round(lag / 60)} min`} later` };
}
