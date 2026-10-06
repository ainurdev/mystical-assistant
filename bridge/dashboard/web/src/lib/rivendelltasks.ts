// What a RIVENDELL card says: its due date, and — from the task's newest
// implementation request — its state line and the one action it offers.
// Pure, so rivendelltasks.check.ts can pin it; the panel only draws.
import type { RivendellRun, RivendellStatus, RivendellTask, RivendellTest } from "../api";
import { fmtDuration, kilo } from "./surfaces.ts";

export type DueTone = "late" | "soon" | "";
export type CardTone = "warn" | "acc" | "ok" | "err" | "";
export type CardAction = "implement" | "open" | "again" | "retry" | null;

const DAY = 86_400_000;

/** "2d late" / "due today" / "due Fri" (within a week) / "due Oct 9". The date
 *  is read by its calendar day — 20261002, 2026-10-02 and an ISO stamp alike —
 *  so a late-evening UTC stamp is not a day early or late here. */
export function dueLabel(due: string | null, today: Date): { text: string; tone: DueTone } | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(due ?? "");
  if (!m) return null;
  const day = new Date(+m[1], +m[2] - 1, +m[3]);
  const days = Math.round((day.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY);
  if (days < 0) return { text: `${-days}d late`, tone: "late" };
  if (days === 0) return { text: "due today", tone: "soon" };
  if (days < 7) return { text: `due ${day.toLocaleDateString("en-US", { weekday: "short" })}`, tone: "soon" };
  return { text: `due ${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, tone: "" };
}

function age(iso: string, now: Date): string {
  const s = (now.getTime() - Date.parse(iso)) / 1000;
  if (!(s >= 60)) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The card's state line and action (docs/superpowers/specs/rivendell-tasks-tab.md).
 *  Queued offers nothing — a second click would only queue a second run — and
 *  OPEN SESSION only exists when this bridge is the one running it. */
export function cardState(
  t: Pick<RivendellTask, "implementation" | "session_id">, now: Date,
): { line: string | null; tone: CardTone; action: CardAction } {
  const r = t.implementation;
  if (!r || r.status === "CANCELLED") return { line: null, tone: "", action: "implement" };
  if (r.status === "PENDING") return { line: "◷ QUEUED", tone: "warn", action: null };
  if (r.status === "IN_PROGRESS") {
    return { line: `● RUNNING · ${age(r.createdAt, now)}`, tone: "acc", action: t.session_id ? "open" : null };
  }
  const when = age(r.completedAt ?? r.createdAt, now);
  const since = when === "just now" ? when : `${when} ago`;
  return r.status === "COMPLETED"
    ? { line: `✓ DONE · ${since}`, tone: "ok", action: "again" }
    : { line: `✕ FAILED · ${since}`, tone: "err", action: "retry" };
}

/** "Mahdi Pourismaiel" -> "MP" for an assignee dot. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

/** Epoch seconds as the tab's short age: "now", "12m", "3h", "2d" ("" for none). */
export function since(sec: number | null | undefined, now: Date): string {
  if (!sec) return "";
  const a = age(new Date(sec * 1000).toISOString(), now);
  return a === "just now" ? "now" : a;
}

export type LinkTone = "ok" | "warn" | "err" | "off";

/** The connection chip beside the project name — one state per riStatusView
 *  state (SettingsModal), in the tab's words (spec §B). */
export function linkChip(s: RivendellStatus | undefined, now: Date): { label: string; tone: LinkTone } {
  switch (s?.state) {
    case "connected": {
      const last = since(s.last_event_at, now);
      return { label: last ? `LINKED · ${last}` : "LINKED", tone: "ok" };
    }
    case "connecting": return { label: "CONNECTING…", tone: "warn" };
    case "error": {
      const wait = s.retry_at ? Math.max(0, Math.round(s.retry_at - now.getTime() / 1000)) : null;
      return { label: `RETRY ${s.attempt || 1}${wait === null ? "" : ` · ${wait}s`}`, tone: "warn" };
    }
    case "auth_error": return { label: "TOKEN REJECTED", tone: "err" };
    default: return { label: "OFF", tone: "off" };
  }
}

/** The close code (4401/4403) or HTTP status (401/403) a token rejection's
 *  detail carries, for the TOKEN REJECTED banner. */
export function closeCode(detail: string | undefined): string | null {
  return /\b(4\d\d\d?)\b/.exec(detail ?? "")?.[1] ?? null;
}

const CHECKS: Record<string, string> = { pass: "✓ checks", fail: "✕ checks", pending: "◷ checks" };

/** A finished run's line: the PR its summary names (with its checks), wall time
 *  and tokens; for a failure, the outcome the transcript shows (bridge/outcomes.py). */
export function resultBits(r: RivendellRun["result"] | undefined): {
  pr: { label: string; url: string; checks: string | null } | null; rest: string; outcome: string | null;
} | null {
  if (!r) return null;
  const tok = r.tokens ? r.tokens.in + r.tokens.out : 0;
  return {
    pr: r.pr ? { label: `PR #${r.pr.number}`, url: r.pr.url, checks: CHECKS[r.pr.checks ?? ""] ?? null } : null,
    rest: [r.wall_s > 0 ? fmtDuration(r.wall_s) : "", tok ? `${kilo(tok)} tok` : ""].filter(Boolean).join(" · "),
    outcome: r.outcome ? `${r.outcome.label}${r.outcome.detail ? ` — ${r.outcome.detail}` : ""}` : null,
  };
}

/** NEEDS YOU first — a run held on a question jumps the list — then YOURS and TEAM. */
export function groupTasks<T extends Pick<RivendellTask, "mine" | "run">>(tasks: T[]) {
  const rest = tasks.filter((t) => !t.run?.ask);
  return { needs: tasks.filter((t) => t.run?.ask), mine: rest.filter((t) => t.mine), team: rest.filter((t) => !t.mine) };
}

/** The bell's line for a broken link (App, once per break). */
export function linkAlertText(i: { name: string; status?: RivendellStatus }): string {
  const at = i.status?.down_since ? new Date(i.status.down_since * 1000).toTimeString().slice(0, 5) : "";
  return i.status?.state === "auth_error"
    ? `Rivendell ${i.name} refused this bridge's token${at ? ` at ${at}` : ""}. Jobs are paused until you replace it.`
    : `Rivendell ${i.name} unreachable${at ? ` since ${at}` : ""}. The bridge keeps retrying.`;
}

/** TEST LINK's last outcome in words (Settings ▸ PLUGINS, the tab's banner). */
export function testText(t: RivendellTest | null | undefined): string {
  if (!t) return "never tested";
  if (t.ok === null) return `↻ ${t.detail}`;
  return t.ok ? `✓ round trip ${t.rtt_ms} ms` : `✕ ${t.detail}`;
}
