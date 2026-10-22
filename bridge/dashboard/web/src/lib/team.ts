// TEAM (bridge/team.py): which Rivendell teammates have Mystical on, and what you
// sent each other. Drawn by components/hud/TeamPanel.tsx, the send sheet
// (components/TeamSendSheet.tsx) and the received bar (components/TeamBar.tsx).
// Checked by team.check.ts.
import type { Received, Share, Teammate } from "../api";
import { isDeviceRun } from "./devicerun.ts";
import { ago, hhmm } from "./surfaces.ts";

/** Is this the origin of a session a teammate sent? */
export const isTeam = (origin?: string | null): boolean => !!origin?.startsWith("team:");

/** Someone else's session: a teammate's device run, or one a teammate sent. Read only here. */
export const readOnly = (origin?: string | null): boolean => isDeviceRun(origin) || isTeam(origin);

/** The PROJECTS group the sessions teammates sent list under (lib/jobs jobGroup).
 *  Not a path, so it can't collide with a folder. */
export const SHARED_REL = "team:shared";
export const SHARED_NAME = "Shared";

/** A share you opened or continued: it leaves SENT TO YOU (and the rail's count)
 *  for SEEN, where it stays until you remove it or it expires. */
export const seen = (r: Pick<Received, "opened" | "continued">): boolean => r.opened || r.continued;

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

export type SentTone = "ok" | "purple" | "warn" | "dim" | "err";

/** How far a share you sent got, as YOU SENT says it. A send waiting for its turn to end
 *  reads AFTER ITS TURN, and NOT SENT when it was tried and failed. */
export function sentStatus(s: Pick<Share, "deliveredAt" | "openedAt" | "continuedAt" | "dismissedAt" | "queued" | "error">, now: number):
  { text: string; tone: SentTone } {
  if (s.queued) return s.error ? { text: "NOT SENT", tone: "err" } : { text: "AFTER ITS TURN", tone: "warn" };
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

/** A share's thread: what ties the sends of one session together (bridge/team.py). */
const threadOf = (s: { meta?: Record<string, unknown> }): string => (typeof s.meta?.thread === "string" ? s.meta.thread : "");

/** YOU SENT: a session sent to someone again shows once, as its newest send. Waiting
 *  sends and sends from an older bridge (no thread) show as they are. Rows come newest first. */
export function foldSent(rows: Share[]): Share[] {
  const shown = new Set<string>();
  return rows.filter((s) => {
    const key = !s.queued && threadOf(s) ? `${threadOf(s)} ${s.to.id}` : "";
    if (!key) return true;
    if (shown.has(key)) return false;
    shown.add(key);
    return true;
  });
}

/** What `to` already has of a session, by its thread: your newest send of it to them and
 *  how many sends there were. null when it never went to them (or YOU SENT's last 20 don't
 *  reach back that far). */
export function sentBefore(rows: Share[], thread: string | undefined, to: string): { last: Share; count: number } | null {
  if (!thread) return null;
  const sent = rows.filter((s) => !s.queued && s.to.id === to && threadOf(s) === thread);
  return sent.length ? { last: sent[0], count: sent.length } : null;
}

/** The line a card gets when it is a newer state of a thread you have: what's new (`strong`)
 *  and against what (`rest`). `sentBack` is your newest send of it to its sender. */
export function relationLine(
  r: Pick<Received, "relation" | "version" | "new_turns" | "prev" | "from">,
  now: number, sentBack?: Share | null, h12?: boolean,
): { strong: string; rest: string } | null {
  const n = r.new_turns;
  if (!r.relation || typeof n !== "number") return null;
  const turns = `${n} turn${n === 1 ? "" : "s"}`;
  if (r.relation === "back") {
    const at = epoch(sentBack?.sentAt);
    const first = r.from.name.split(" ")[0] || r.from.name;
    return { strong: `${turns} on top of yours`, rest: at ? ` · you sent it to ${first} ${ago(at, now)} ago` : "" };
  }
  // From the version you last opened or continued, never one that folded in unseen.
  const since = r.prev?.version ? `v${r.prev.version}` : r.prev ? "yours" : (r.version ?? 1) > 1 ? `v${(r.version ?? 2) - 1}` : "yours";
  const at = r.prev?.at ?? null;
  const when = at ? (sameDay(at, now) ? `at ${hhmm(at, h12)}` : `${ago(at, now)} ago`) : "";
  const rest = r.prev?.state === "continued" ? `, which you continued${when ? ` ${when}` : ""}`
    : r.prev?.state === "opened" ? ", which you opened" : "";
  return { strong: `+${turns} since ${since}`, rest };
}
