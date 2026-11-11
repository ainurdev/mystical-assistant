import type { CouncilBrief } from "../api";
import type { Turn } from "../chat";
import { live } from "./council.ts";

/* What the FLOW tab draws, as plain data: one station per step of the session's
   path, which is done, which is running, which waits on you, which starts by
   itself. Pure, so flowview.check.ts can pin it.

   `now` needs a running turn: between turns the step that comes next shows its
   own kind (you / auto) instead, since nothing is working on it yet. BUILD and
   MERGE run in sessions of their own, so the ticket set says when they run
   instead, and with TICKETS off nothing builds or merges by itself: they are yours.
   The REVIEW after MERGE is the council's, in the merge session: the set carries
   that council's run, and one that stopped waits on you. */

export interface Flow {
  path: string; skill?: string | null; by: "rule" | "claude"; why: string; auto: boolean; at: number;
  done: string[]; next: { station: string; turn_id: string; started?: boolean } | null;
  /** The path's steps as the bridge runs them: REVIEW only where it follows MERGE. */
  stations?: [string, string | null, "you" | "auto"][];
}
/** The flow's ticket set, as GET /local/flow sends it (bridge/tickets.py flow_set). `review` is the
    council's run in the merge session, sent once the set is merged. */
export interface FlowSet {
  status: string; error?: string; flow_at?: number; tickets: Record<string, { status: string }>;
  review?: Pick<CouncilBrief, "status" | "reason" | "round" | "max_rounds">;
}
export type StationState = "done" | "now" | "you" | "auto" | "next";
export interface FlowView {
  stations: { key: string; label: string; skill: string | null; who: "you" | "auto"; state: StationState }[];
  step: number; total: number; why: string; by: "rule" | "claude";
  nowTurn?: { started: number; tools: number; activity: string };
  note?: string; // what the ticket set says: tickets done and running, merging, why it stopped, or where the review stands
}

// Mirrors bridge/paths.py PATHS as it was before the bridge sent `stations`: an older bridge's paths.
export const PATHS: Record<string, [string, string | null, "you" | "auto"][]> = {
  feature: [["grill", "grill-with-docs", "you"], ["spec", "to-spec", "auto"], ["tickets", "to-tickets", "you"],
    ["build", null, "auto"], ["merge", null, "auto"], ["retro", "retro", "auto"]],
  "feature-here": [["grill", "grill-with-docs", "you"], ["build-here", "implement", "auto"], ["retro", "retro", "auto"]],
  bug: [["diagnose", "diagnosing-bugs", "auto"], ["retro", "retro", "auto"]],
  refactor: [["improve", "improve-codebase-architecture", "you"], ["tickets", "to-tickets", "you"],
    ["build", null, "auto"], ["merge", null, "auto"], ["retro", "retro", "auto"]],
};

export function flowView(flow: Flow | null, turns: Turn[], set: FlowSet | null = null, ticketruns = true): FlowView {
  if (!flow) return { stations: [], step: 0, total: 0, why: "", by: "rule" };
  if (set?.flow_at !== undefined && set.flow_at !== flow.at) set = null;   // built for an earlier path here
  const table = flow.stations ?? PATHS[flow.path] ?? [[flow.skill ?? "skill", flow.skill ?? null, "auto"] as [string, string | null, "you" | "auto"]];
  const running = [...turns].reverse().find((t) => t.status === "running");
  const first = table.findIndex(([k]) => !flow.done.includes(k));
  const council = set?.status === "merged" ? set.review : undefined;
  const elsewhere: Record<string, boolean> = { build: set?.status === "building", merge: set?.status === "merging",
    review: !!council && live(council) };
  const approving = set?.status === "approve";   // APPROVE BEFORE BUILD: the set waits for the user's tap
  const stations = table.map(([key, skill, kind], i) => {
    // a started step with no turn running ended without StepDone (a question): it waits on you
    const asked = i === first && !running && !!flow.next?.started && flow.next.station === key;
    const who = !ticketruns && (key === "build" || key === "merge") || approving && key === "build" || asked
      || key === "review" && council?.status === "stopped" ? "you" : kind;
    // only a step with no skill runs elsewhere: a review that has one is a turn in this session
    const now = skill === null && key in elsewhere ? elsewhere[key] : i === first && !!running;
    return { key, label: key.replace(/-/g, " "), skill, who, state: (flow.done.includes(key) ? "done" : now ? "now" : who) as StationState };
  });
  const tks = Object.values(set?.tickets ?? {});
  const note = approving ? "waiting for your approval" : set?.status === "building" ? `${tks.filter((t) => t.status === "done").length} of ${tks.length} tickets done, ${tks.filter((t) => t.status === "running").length} running`
    : set?.status === "merging" ? "one session merges the tickets"
    : set?.status === "stopped" ? `stopped: ${set.error || "the set couldn't build"}`
    : council?.status === "reviewing" ? `council round ${council.round} of ${council.max_rounds}`
    : council?.status === "fixing" ? `fixing round ${council.round}'s findings`
    : council?.status === "stopped" ? `stopped: ${council.reason}` : undefined;
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
