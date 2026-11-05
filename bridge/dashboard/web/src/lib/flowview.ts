import type { Turn } from "../chat";

/* What the FLOW tab draws, as plain data: one station per step of the session's
   path, which is done, which is running, which waits on you, which starts by
   itself. Pure, so flowview.check.ts can pin it.

   `now` needs a running turn: between turns the step that comes next shows its
   own kind (you / auto) instead, since nothing is working on it yet. */

export interface Flow {
  path: string; by: "rule" | "claude"; why: string; auto: boolean; at: number;
  done: string[]; next: { station: string; turn_id: string } | null;
}
export type StationState = "done" | "now" | "you" | "auto" | "next";
export interface FlowView {
  stations: { key: string; label: string; skill: string | null; who: "you" | "auto"; state: StationState }[];
  step: number; total: number; why: string; by: "rule" | "claude";
  nowTurn?: { started: number; tools: number; activity: string };
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

export function flowView(flow: Flow | null, turns: Turn[]): FlowView {
  if (!flow) return { stations: [], step: 0, total: 0, why: "", by: "rule" };
  // shortcut: a one-skill path's skill isn't in GET /local/flow, so it draws as one station named "skill"; send it with the flow to name it.
  const table = PATHS[flow.path] ?? [["skill", null, "auto"] as [string, string | null, "you" | "auto"]];
  const running = [...turns].reverse().find((t) => t.status === "running");
  const first = table.findIndex(([k]) => !flow.done.includes(k));
  const stations = table.map(([key, skill, who], i) => ({
    key, label: key.replace(/-/g, " "), skill, who,
    state: (flow.done.includes(key) ? "done" : i === first && running ? "now" : who) as StationState,
  }));
  const tools = running?.events.filter((e) => e.type === "tool") ?? [];
  const last = tools[tools.length - 1];
  return {
    stations, step: Math.min(flow.done.length + 1, table.length), total: table.length, why: flow.why, by: flow.by,
    nowTurn: running ? {
      started: running.started ?? 0, tools: tools.length,
      activity: last && last.type === "tool" ? [last.name, last.summary].filter(Boolean).join(" · ") : "",
    } : undefined,
  };
}
