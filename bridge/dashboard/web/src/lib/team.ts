// TEAM (bridge/team.py): which Rivendell teammates have Mystical on, and what you
// sent each other. Drawn by components/hud/TeamPanel.tsx, the send sheet
// (components/TeamSendSheet.tsx) and the received bar (components/TeamBar.tsx).
// Checked by team.check.ts.
import type { Share, Teammate } from "../api";
import { isDeviceRun } from "./devicerun.ts";
import { ago, hhmm } from "./surfaces.ts";

/** Is this the origin of a session a teammate sent? */
export const isTeam = (origin?: string | null): boolean => !!origin?.startsWith("team:");

/** Someone else's session: a teammate's device run, or one a teammate sent. Read only here. */
export const readOnly = (origin?: string | null): boolean => isDeviceRun(origin) || isTeam(origin);

export const KIND_LABEL = { session: "SESSION", picture: "PICTURE", file: "FILE" } as const;

// Never the error red: a person is not an alarm.
const PALETTE = ["var(--info)", "var(--purple)", "var(--warn)", "var(--ok)", "color-mix(in srgb, var(--ok), var(--info))"];

/** A teammate's colour, the same on every surface: by their id. */
export function personTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const DAY = 86400;
const sameDay = (a: number, b: number) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
const epoch = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) / 1000 : NaN;
  return Number.isNaN(t) ? null : t;
};

/** The roster's second line: on since when, last on when, or never linked. */
export function presence(t: Pick<Teammate, "online" | "lastSeenAt">, now: number, h12?: boolean): string {
  const at = epoch(t.lastSeenAt);
  if (t.online) return at && sameDay(at, now) ? `on now · since ${hhmm(at, h12)}` : "on now";
  if (!at) return "no Mystical linked yet";
  if (now - at < 60) return "last on just now";
  if (now - at < 3600) return `last on ${ago(at, now)} ago`;
  if (sameDay(at, now)) return `last on today, ${hhmm(at, h12)}`;
  if (sameDay(at, now - DAY)) return `last on yesterday, ${hhmm(at, h12)}`;
  return `last on ${new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/** Who's on first, then by name. */
export const byPresence = (a: Teammate, b: Teammate): number =>
  Number(b.online) - Number(a.online) || a.name.localeCompare(b.name);

export type SentTone = "ok" | "purple" | "warn" | "dim";

/** How far a share you sent got, as YOU SENT says it. */
export function sentStatus(s: Pick<Share, "deliveredAt" | "openedAt" | "continuedAt" | "dismissedAt">, now: number):
  { text: string; tone: SentTone } {
  if (s.continuedAt) return { text: "CONTINUED", tone: "purple" };
  const opened = epoch(s.openedAt);
  if (opened) {
    const a = ago(opened, now);
    return { text: a === "now" ? "OPENED NOW" : `OPENED ${a.toUpperCase()}`, tone: "ok" };
  }
  if (s.dismissedAt) return { text: "DISMISSED", tone: "dim" };
  if (s.deliveredAt) return { text: "DELIVERED", tone: "dim" };
  return { text: "WAITING", tone: "warn" };
}

/** A received share's age, from when it was sent: "12m", "3h", "now". */
export const sentAgo = (iso: string, now: number): string => ago(epoch(iso), now);

/** Bytes, the way a file card says them. */
export function size(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** The facts a card prints under the note: where a session came from and what came
 *  with it, or a picture's or file's size. */
export function shareFacts(kind: string, meta: Record<string, unknown>): { project?: string; branch?: string; bits: string[] } {
  if (kind !== "session") return { bits: [size(meta.bytes)].filter(Boolean) };
  const repo = typeof meta.repo === "string" ? meta.repo : "";
  const project = repo.split("/").pop() || (typeof meta.project === "string" ? meta.project.split("/").pop() : "") || "";
  const bits: string[] = [];
  if (typeof meta.turns === "number") bits.push(`${meta.turns} turn${meta.turns === 1 ? "" : "s"}`);
  if (typeof meta.pictures === "number" && meta.pictures > 0) bits.push(`${meta.pictures} picture${meta.pictures === 1 ? "" : "s"}`);
  if (meta.code === true) bits.push("code");
  return { project: project || undefined, branch: typeof meta.branch === "string" ? meta.branch : undefined, bits };
}
