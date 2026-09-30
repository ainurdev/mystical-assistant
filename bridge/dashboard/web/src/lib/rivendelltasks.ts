// What a RIVENDELL card says: its due date, and — from the task's newest
// implementation request — its state line and the one action it offers.
// Pure, so rivendelltasks.check.ts can pin it; the panel only draws.
import type { RivendellTask } from "../api";

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
