import type { Turn } from "../chat";

/* What the FLOW tab draws, as plain data: one station per step of the session's
   path, which is done, which is running, which waits on you, which starts by
   itself. Pure, so flowview.check.ts can pin it.

   `now` needs a running turn: between turns the step that comes next shows its
   own kind (you / auto) instead, since nothing is working on it yet. BUILD and
   MERGE run in sessions of their own, so the ticket set says when they run
   instead, and with TICKETS off nothing builds or merges by itself: they are yours. */

export interface Flow {
  path: string; skill?: string | null; by: "rule" | "claude"; why: string; auto: boolean; at: number;
  done: string[]; next: { station: string; turn_id: string } | null;
}
/** The flow's ticket set, as GET /local/flow sends it (bridge/tickets.py summary_for). */
export interface FlowSet { status: string; error?: string; flow_at?: number; tickets: Record<string, { status: string }> }
export type StationState = "done" | "now" | "you" | "auto" | "next";
export interface FlowView {
  stations: { key: string; label: string; skill: string | null; who: "you" | "auto"; state: StationState }[];
  step: number; total: number; why: string; by: "rule" | "claude";
  nowTurn?: { started: number; tools: number; activity: string };
  note?: string; // what the ticket set says: tickets done and running, merging, or why it stopped
}

// Mirrors bridge/paths.py PATHS: station, skill (null = the agent just does it), who starts it.
export const PATHS: Record<string, [string, string | null, "you" | "auto"][]> = {
  feature: [["grill", "grill-with-docs", "you"], ["spec", "to-spec", "auto"], ["tickets", "to-tickets", "you"],
    ["build", null, "auto"], ["merge", null, "auto"], ["retro", "retro", "auto"]],
  "feature-here": [["grill", "grill-with-docs", "you"], ["build-here", "implement", "auto"], ["retro", "retro", "auto"]],
  bug: [["diagnose", "diagnosing-bugs", "auto"], ["fix", "tdd", "auto"], ["retro", "retro", "auto"]],
  refactor: [["improve", "improve-codebase-architecture", "you"], ["tickets", "to-tickets", "you"],
    ["build", null, "auto"], ["merge", null, "auto"], ["retro", "retro", "auto"]],
};

export function flowView(flow: Flow | null, turns: Turn[], set: FlowSet | null = null, ticketruns = true): FlowView {
  if (!flow) return { stations: [], step: 0, total: 0, why: "", by: "rule" };
  if (set?.flow_at !== undefined && set.flow_at !== flow.at) set = null;   // built for an earlier path here
  const table = PATHS[flow.path] ?? [[flow.skill ?? "skill", flow.skill ?? null, "auto"] as [string, string | null, "you" | "auto"]];
  const running = [...turns].reverse().find((t) => t.status === "running");
  const first = table.findIndex(([k]) => !flow.done.includes(k));
  const elsewhere: Record<string, boolean> = { build: set?.status === "building", merge: set?.status === "merging" };
  const stations = table.map(([key, skill, kind], i) => {
    const who = !ticketruns && (key === "build" || key === "merge") ? "you" : kind;
    const now = key in elsewhere ? elsewhere[key] : i === first && !!running;
    return { key, label: key.replace(/-/g, " "), skill, who, state: (flow.done.includes(key) ? "done" : now ? "now" : who) as StationState };
  });
  const tks = Object.values(set?.tickets ?? {});
  const note = set?.status === "building" ? `${tks.filter((t) => t.status === "done").length} of ${tks.length} tickets done, ${tks.filter((t) => t.status === "running").length} running`
    : set?.status === "merging" ? "one session merges the tickets"
    : set?.status === "stopped" ? `stopped: ${set.error || "the set couldn't build"}` : undefined;
  const tools = running?.events.filter((e) => e.type === "tool") ?? [];
  const last = tools[tools.length - 1];
  return {
    stations, step: Math.min(flow.done.length + 1, table.length), total: table.length, why: flow.why, by: flow.by, note,
    nowTurn: running ? {
      started: running.started ?? 0, tools: tools.length,
      activity: last && last.type === "tool" ? [last.name, last.summary].filter(Boolean).join(" · ") : "",
    } : undefined,
  };
}
