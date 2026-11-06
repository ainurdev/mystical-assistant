// Multi-agent chats, the pure half (docs/superpowers/plans/multi-agent-chats.md;
// lib/multistore is the half that talks to the bridge). Everything here decides,
// nothing here draws: which agents a chat's fold shows and in what order, what
// a helper's state reads as, what a ⇄ message is, and the brief a helper session
// is opened with.
//
// The bridge sends rows unsorted (bridge/agent_tree.py says why): the sort is the
// browser's own pick and the order moves as often as the status does.
import type { SessionBrief } from "../api";

export type HelperMode = "off" | "ask" | "auto";

export interface Caps {
  steer: "native" | "soft";
  ask: "native" | "gateway";
  block: boolean;
  system_prompt: boolean;
  subagents: "detailed" | "opaque";
  usage: boolean;
  compact: boolean;
  tools_switch: boolean;
  goals: boolean;
  duplicate: boolean;
  skills_prefix: string;
}

/** A chat's limits (bridge/channel.py config_for). */
export interface HelperConfig {
  helpers: HelperMode;
  max_agents: number;
  max_hops: number;
  per_account: number;
  held?: boolean;
}

export interface MemberInfo {
  name?: string;
  write?: boolean;
  brief?: string;
  state?: string;
  started?: number;
  ended?: number;
  conflict?: boolean;
  merged?: boolean;
  copy?: { path?: string } | null;
}

/** One agent under a chat (bridge/agent_tree.py): a helper, a Claude subagent, or
 *  another provider's own sub-agent we can only say exists. */
export interface AgentRow {
  key: string;
  kind: "member" | "subagent" | "opaque";
  name: string;
  provider: string;
  account?: string;
  model?: string | null;
  status: string;
  needs: boolean;
  detail: boolean;
  session_id?: string;
  agent_id?: string;
  workflow?: string | null;
  started?: number | null;
  updated?: number | null;
  owner?: string;
  write?: boolean;
  brief?: string;
  conflict?: boolean;
  merged?: boolean;
  has_copy?: boolean;
  activity?: string;
}

export interface ChannelMessage {
  id: string;
  chat: string;
  sender: string;
  recipient: string;
  kind: string;
  body: string;
  meta?: Record<string, unknown> | string | null;
  state: string;
  at: number;
}

export interface ChannelView {
  config: HelperConfig;
  messages: ChannelMessage[];
  chat: string;
  rows: AgentRow[];
}

export type TreeSort = "attention" | "newest" | "name" | "provider";
export const TREE_SORTS: { id: TreeSort; label: string }[] = [
  { id: "attention", label: "Attention" },
  { id: "newest", label: "Newest" },
  { id: "name", label: "Name" },
  { id: "provider", label: "Provider" },
];
export const asSort = (s: string | null | undefined): TreeSort =>
  TREE_SORTS.find((x) => x.id === s)?.id ?? "attention";

export const isRunning = (r: Pick<AgentRow, "status">) => r.status === "running";
/** The fold's rows and a card's click: a row with no detail has nothing to open. */
export const canOpen = (r: AgentRow) => r.detail && !!r.session_id && (r.kind === "member" || !!r.agent_id);

const stamp = (r: AgentRow) => r.updated ?? r.started ?? 0;
const rank = (r: AgentRow) => (r.needs ? 0 : isRunning(r) ? 1 : 2);
const byName = (a: AgentRow, b: AgentRow) => a.name.localeCompare(b.name);

const COMPARE: Record<TreeSort, (a: AgentRow, b: AgentRow) => number> = {
  attention: (a, b) => rank(a) - rank(b) || stamp(b) - stamp(a) || byName(a, b),
  newest: (a, b) => (b.started ?? stamp(b)) - (a.started ?? stamp(a)) || byName(a, b),
  name: byName,
  provider: (a, b) => a.provider.localeCompare(b.provider) || byName(a, b),
};

export function sortRows(rows: AgentRow[], sort: TreeSort): AgentRow[] {
  return [...rows].sort(COMPARE[sort]);
}

export const FOLD_ROWS = 3;

/** What a chat's fold draws. Shut, its rows are always chosen by attention,
 *  whatever the sort, and everything that needs you is one of them even past
 *  three: the fold exists to be calm, never to hide a question. They are then
 *  drawn in the picked sort. Open, every row in the picked sort. */
export function foldRows(rows: AgentRow[], sort: TreeSort, expanded: boolean, n = FOLD_ROWS): { shown: AgentRow[]; hidden: number } {
  if (expanded || rows.length <= n) return { shown: sortRows(rows, sort), hidden: 0 };
  const byAttention = sortRows(rows, "attention");
  const needs = rows.filter((r) => r.needs).length;
  const keep = byAttention.slice(0, Math.max(n, needs));
  return { shown: sortRows(keep, sort), hidden: rows.length - keep.length };
}

/** The fold's header counts. */
export function tally(rows: AgentRow[]): { total: number; running: number; needs: number } {
  return { total: rows.length, running: rows.filter(isRunning).length, needs: rows.filter((r) => r.needs).length };
}

const STATUS_WORD: Record<string, string> = {
  running: "working", done: "done", failed: "failed", stopped: "stopped",
  merged: "merged", discarded: "discarded", unknown: "not moving",
};
export const statusWord = (s: string) => STATUS_WORD[s] ?? s;

/** Seconds a row has been at it, or took; null with no clock to read. */
export function elapsedOf(r: AgentRow, now: number): number | null {
  if (!r.started) return null;
  if (isRunning(r)) return Math.max(0, now - r.started);
  return r.updated && r.updated >= r.started ? r.updated - r.started : null;
}

export type Tag = { text: string; tone: "warn" | "err" | "ok" | "dim"; title: string };

/** The small marks a helper's row and card wear for what its copy of the code is
 *  doing. A conflict wins over the rest: it's the one that wants someone. */
export function rowTags(r: AgentRow): Tag[] {
  const out: Tag[] = [];
  if (r.conflict) out.push({ text: "CONFLICT", tone: "err", title: "Its changes clash with your folder. Nothing was applied: ask the main agent to resolve them, or discard them." });
  if (r.merged || r.status === "merged") out.push({ text: "MERGED", tone: "ok", title: "Its changes are in your folder, uncommitted." });
  else if (r.has_copy) out.push({ text: "OWN COPY", tone: r.conflict ? "dim" : "warn", title: "It works in its own copy of the code. Its changes aren't in your folder until they're merged." });
  if (r.status === "discarded") out.push({ text: "DISCARDED", tone: "dim", title: "Its copy of the code was thrown away." });
  return out;
}

/** What can be done to a writer's copy right now. */
export function mergeActions(r: AgentRow): ("review" | "merge" | "discard" | "undo")[] {
  if (r.kind !== "member" || !r.write) return [];
  if (r.merged || r.status === "merged") return ["undo"];
  if (r.status === "discarded" || !r.has_copy || isRunning(r)) return [];
  return ["review", "merge", "discard"];
}

// ---- ⇄ ---------------------------------------------------------------------
// bridge/channel.py frames whatever it hands an agent. Those frames land in the
// transcript as a turn's prompt or a steer, and most aren't your words.

export type Frame =
  | { kind: "user"; from: null; verb: null; body: string }
  | { kind: "agent"; from: string; verb: "says" | "reports back"; body: string }
  | { kind: "brief"; from: string; verb: null; body: string }
  | { kind: "other"; from: null; verb: null; body: string };

const AGENT_FRAME = /^⇄ (.+?) (says|reports back)\. It comes from another agent[^\n]*\n+/;
const USER_FRAME = /^⇄ From the user, sent to you directly:\n+/;
const BRIEF_MARK = "\n\nYour brief:\n";

export function parseFrame(text: string | null | undefined): Frame | null {
  if (!text || !text.startsWith("⇄")) return null;
  const user = USER_FRAME.exec(text);
  if (user) return { kind: "user", from: null, verb: null, body: text.slice(user[0].length) };
  const agent = AGENT_FRAME.exec(text);
  if (agent) return { kind: "agent", from: agent[1], verb: agent[2] as "says" | "reports back", body: text.slice(agent[0].length) };
  if (text.startsWith("⇄ You were started as a helper")) {
    const at = text.indexOf(BRIEF_MARK);
    return { kind: "brief", from: "main agent", verb: null, body: at < 0 ? text.slice(1).trim() : text.slice(at + BRIEF_MARK.length) };
  }
  return { kind: "other", from: null, verb: null, body: text.slice(1).trim() };
}

/** A prompt line for lists that show one row a turn (the checkpoints rail). */
export function promptLabel(text: string): string {
  const f = parseFrame(text);
  if (!f) return text;
  if (f.kind === "agent") return `${f.from}: ${f.body}`;
  if (f.kind === "brief") return `Brief: ${f.body}`;
  return f.body;
}

// ---- transcript rows --------------------------------------------------------

export function mergeLine(name: string, state: string): string {
  switch (state) {
    case "merged": return `${name}'s changes are in your folder, uncommitted`;
    case "conflict": return `${name}'s changes clash with your folder, nothing was applied`;
    case "undone": return `${name}'s merge was undone`;
    case "discarded": return `${name}'s copy was thrown away`;
    default: return `${name}: ${state}`;
  }
}

// ---- limits -----------------------------------------------------------------

// bridge/experimental.py LIMITS.
export const LIMITS = {
  max_agents: { lo: 1, hi: 20, word: "agents", tip: "How many helpers this chat may have at once." },
  per_account: { lo: 1, hi: 20, word: "per login", tip: "How many of them may spend one login at once." },
  max_hops: { lo: 1, hi: 200, word: "hops", tip: "Messages between agents before the channel holds and asks you." },
} as const;
export type LimitKey = keyof typeof LIMITS;
export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];

export const clampLimit = (k: LimitKey, n: number) =>
  Math.min(LIMITS[k].hi, Math.max(LIMITS[k].lo, Math.round(Number.isFinite(n) ? n : LIMITS[k].lo)));

export const DEFAULT_CONFIG: HelperConfig = { helpers: "ask", max_agents: 5, max_hops: 20, per_account: 3 };

// ---- the composer -----------------------------------------------------------

/** Profile names for an `@` query, best first: the name starts with it, then a
 *  later word does, then it appears anywhere. */
export function rankProfiles(names: string[], q: string, limit = 6): string[] {
  const low = q.toLowerCase();
  const scored: { n: string; s: number }[] = [];
  for (const n of names) {
    const l = n.toLowerCase();
    const s = !low || l.startsWith(low) ? 0 : l.split(/\s+/).some((w) => w.startsWith(low)) ? 1 : l.includes(low) ? 2 : -1;
    if (s >= 0) scored.push({ n, s });
  }
  scored.sort((a, b) => a.s - b.s || a.n.localeCompare(b.n));
  return scored.slice(0, limit).map((x) => x.n);
}

/** What's left of a typed `/skill:na` once the agent's own prefix is off it, so
 *  the list ranks on the skill's name. */
export function skillQuery(q: string, prefix: string): string {
  const own = prefix.replace(/^\//, "").toLowerCase();
  return own && q.startsWith(own) ? q.slice(own.length) : q;
}

export const STEER_SOFT_WORDS = "at its next step";

/** What the session can do when its brief didn't say: only a helper opened from
 *  its row, which has no brief to read (see helperBrief). Same table as
 *  bridge/agent_caps.py. */
export function capsFor(agent: string): Caps {
  if (agent === "claude") {
    return { steer: "native", ask: "native", block: true, system_prompt: true, subagents: "detailed", usage: true,
             compact: true, tools_switch: true, goals: true, duplicate: true, skills_prefix: "/" };
  }
  return { steer: "soft", ask: "gateway", block: false, system_prompt: false, subagents: "opaque", usage: false,
           compact: false, tools_switch: false, goals: true, duplicate: false,
           skills_prefix: agent === "kimi" ? "/skill:" : "/" };
}

/** The ids a sidebar poll asks for: the open chat first, then what's on screen. */
export function treeIds(first: (string | null | undefined)[], rest: string[], max = 40): string[] {
  const out = new Set<string>();
  for (const id of [...first, ...rest]) { if (id && out.size < max) out.add(id); }
  return [...out];
}

export const isLongMessage = (body: string) => body.length > 280 || body.split("\n").length > 4;
export const MAIN = "main";

/** The latest thing an agent said or did, in a line: the main agent's card has only
 *  the open transcript to read this from (bridge/agent_tree.py _activity is the
 *  same rule for a helper). */
export function latestActivity(events: { type: string; text?: string; name?: string; summary?: string }[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "text" && e.text) return e.text.split(/\s+/).join(" ").slice(0, 160);
    if (e.type === "tool") return `${e.name ?? "tool"} ${(e.summary ?? "").slice(0, 120)}`.trim();
  }
  return "";
}
