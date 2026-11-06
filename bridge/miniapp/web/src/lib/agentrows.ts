// The agents under a chat, in the order and to the depth the phone shows them.
// Pure, so the rule that matters is checkable: anything that needs you is never
// behind "+N more", whichever sort you picked. The bridge hands the rows over
// unsorted on purpose (bridge/agent_tree.py): the sort is yours, and the order
// moves as often as the status does.

import type { TreeRow } from "./api";

export type AgentSort = "attention" | "newest" | "name" | "provider";

export const SORTS: { id: AgentSort; label: string }[] = [
  { id: "attention", label: "ATTENTION" },
  { id: "newest", label: "NEWEST" },
  { id: "name", label: "NAME" },
  { id: "provider", label: "PROVIDER" },
];

/** Rows shown before "+N more". */
export const FOLD_CAP = 3;

/** The saved sort, or Attention for anything a storage hands back that isn't one. */
export const asSort = (v: unknown): AgentSort =>
  SORTS.some((s) => s.id === v) ? (v as AgentSort) : "attention";

export const nextSort = (s: AgentSort): AgentSort =>
  SORTS[(SORTS.findIndex((x) => x.id === s) + 1) % SORTS.length].id;

export const sortLabel = (s: AgentSort): string =>
  SORTS.find((x) => x.id === s)?.label ?? "ATTENTION";

type Rowish = Pick<TreeRow, "name" | "provider" | "status" | "needs" | "started" | "updated">;

export const isRunning = (r: Pick<TreeRow, "status">) => r.status === "running";

const tier = (r: Rowish) => (r.needs ? 0 : isRunning(r) ? 1 : 2);
const when = (r: Rowish) => r.updated ?? r.started ?? 0;
const byNewest = (a: Rowish, b: Rowish) => when(b) - when(a);
const byName = (a: Rowish, b: Rowish) => a.name.localeCompare(b.name);

const ORDER: Record<AgentSort, (a: Rowish, b: Rowish) => number> = {
  attention: (a, b) => tier(a) - tier(b) || byNewest(a, b) || byName(a, b),
  newest: (a, b) => byNewest(a, b) || byName(a, b),
  name: (a, b) => byName(a, b) || byNewest(a, b),
  provider: (a, b) => a.provider.localeCompare(b.provider) || tier(a) - tier(b) || byNewest(a, b),
};

export function sortRows<T extends Rowish>(rows: T[], sort: AgentSort): T[] {
  return [...rows].sort(ORDER[sort]);
}

/** What a fold shows. Which rows make the cut is always decided by attention;
 *  your sort only orders the ones that did. So sorting by name can't push the one
 *  that needs you behind the fold, and more than `cap` of them all stay. */
export function foldRows<T extends Rowish>(
  rows: T[], sort: AgentSort, expanded: boolean, cap = FOLD_CAP,
): { shown: T[]; hidden: number } {
  if (expanded || rows.length <= cap) return { shown: sortRows(rows, sort), hidden: 0 };
  const urgent = sortRows(rows, "attention");
  const kept = urgent.filter((r, i) => r.needs || i < cap);
  return { shown: sortRows(kept, sort), hidden: rows.length - kept.length };
}

/** Whether a fold starts open: while anything is going on. A chat whose agents all
 *  finished keeps one line, or every Claude chat that ever ran a subagent would
 *  take four rows of the list for good (plan, section 6). */
export const startsOpen = (rows: Rowish[]) => rows.some((r) => r.needs || isRunning(r));

/** Seconds it has run: up to now while it's going, up to its last move after. */
export function elapsedOf(r: Rowish, nowSec: number): number | null {
  if (!r.started) return null;
  const end = isRunning(r) ? nowSec : r.updated ?? nowSec;
  return Math.max(0, end - r.started);
}

export function fmtElapsed(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/** "5 AGENTS · 1 NEEDS YOU · 2 RUNNING" */
export function tally(rows: Rowish[]): string {
  const needs = rows.filter((r) => r.needs).length;
  const running = rows.filter(isRunning).length;
  return [
    `${rows.length} AGENT${rows.length === 1 ? "" : "S"}`,
    needs ? `${needs} NEED${needs === 1 ? "S" : ""} YOU` : "",
    running ? `${running} RUNNING` : "",
  ].filter(Boolean).join(" · ");
}
