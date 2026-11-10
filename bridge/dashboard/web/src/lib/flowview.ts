import type { Turn } from "../chat";

/* What the FLOW tab draws, as plain data: one station per step of the session's
   path, which is done, which is running, which waits on you, which starts by
   itself. Pure, so flowview.check.ts can pin it.

   `now` needs a running turn: between turns the step that comes next shows its
   own kind (you / auto) instead, since nothing is working on it yet. BUILD and
   MERGE run in sessions of their own, so the ticket set says when they run
   instead, and with TICKETS off nothing builds or merges by itself: they are yours. */

/** The SETTINGS switches one session overrides from the prompt box's FLOW chip (bridge/paths.py OPTIONS). */
export type FlowOption = "nextstep" | "autopick" | "smartzone";
export interface Flow {
  path: string; skill?: string | null; by: "rule" | "claude"; why: string; auto: boolean; at: number;
  done: string[]; next: { station: string; turn_id: string; started?: boolean } | null;
  /** Switches set in this session over SETTINGS; a bridge older than the FLOW chip sends none. */
  overrides?: Partial<Record<FlowOption, boolean>>;
  /** Steps passed over with SKIP or JUMP TO (they're in `done` too). */
  skipped?: string[];
  /** The path's steps as the bridge runs them: REVIEW and AUDIT only while PONYTAIL is on. */
  stations?: [string, string | null, "you" | "auto"][];
}
/** The flow's ticket set, as GET /local/flow sends it (bridge/tickets.py summary_for). */
export interface FlowSet { status: string; error?: string; flow_at?: number; tickets: Record<string, { status: string }> }
export type StationState = "done" | "now" | "you" | "auto" | "next";
export interface FlowView {
  stations: { key: string; label: string; skill: string | null; who: "you" | "auto"; state: StationState; skipped?: boolean }[];
  step: number; total: number; why: string; by: "rule" | "claude";
  nowTurn?: { started: number; tools: number; activity: string };
  note?: string; // what the ticket set says: tickets done and running, merging, or why it stopped
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
  const elsewhere: Record<string, boolean> = { build: set?.status === "building", merge: set?.status === "merging" };
  const approving = set?.status === "approve";   // APPROVE BEFORE BUILD: the set waits for the user's tap
  const stations = table.map(([key, skill, kind], i) => {
    // a started step with no turn running ended without StepDone (a question): it waits on you
    const asked = i === first && !running && !!flow.next?.started && flow.next.station === key;
    const who = !ticketruns && (key === "build" || key === "merge") || approving && key === "build" || asked ? "you" : kind;
    const now = key in elsewhere ? elsewhere[key] : i === first && !!running;
    return { key, label: key.replace(/-/g, " "), skill, who, state: (flow.done.includes(key) ? "done" : now ? "now" : who) as StationState,
      skipped: !!flow.skipped?.includes(key) };
  });
  const tks = Object.values(set?.tickets ?? {});
  const note = approving ? "waiting for your approval" : set?.status === "building" ? `${tks.filter((t) => t.status === "done").length} of ${tks.length} tickets done, ${tks.filter((t) => t.status === "running").length} running`
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

/** What the prompt box's FLOW chip shows (Composer): the step that comes next, whether it
    starts by itself, the three switches this session may set, and where SKIP and JUMP TO
    land. null with no path, with nothing left to start, or on a bridge older than the chip
    (it can't hold a switch per session). */
export interface FlowChip {
  label: string;
  step: number; total: number;
  next: { key: string; label: string };
  /** auto: starts by itself · held: AUTO is held here · you: a step you start */
  mark: "auto" | "held" | "you";
  /** Where SKIP lands: the step after next, "" past the last; null while tickets build or
      merge elsewhere, since a skip there would pass over work under way. */
  skipTo: string | null;
  jumps: { key: string; label: string }[];
  opts: Record<FlowOption, { on: boolean; here: boolean; global: boolean }>;
  here: number;
}

export function flowChip(flow: Flow | null, v: FlowView, ai: Partial<Record<FlowOption, boolean>>): FlowChip | null {
  if (!flow?.overrides) return null;
  const rest = v.stations.filter((s) => s.state !== "done" && s.state !== "now");
  if (!rest.length) return null;
  const own = flow.overrides;
  const away = v.stations.some((s) => s.state === "now") && !v.nowTurn;
  const opt = (k: FlowOption, on: boolean) => ({ on, here: k in own, global: !!ai[k] });
  return {
    label: flow.path === "one" ? flow.skill ?? "one skill" : flow.path.replace(/-/g, " "),
    step: v.step, total: v.total,
    next: { key: rest[0].key, label: rest[0].label },
    mark: rest[0].who === "you" ? "you" : flow.auto ? "auto" : "held",
    skipTo: away ? null : rest[1]?.key ?? "",
    jumps: away ? [] : rest.slice(1).map((s) => ({ key: s.key, label: s.label })),
    opts: { nextstep: opt("nextstep", flow.auto), autopick: opt("autopick", own.autopick ?? !!ai.autopick),
            smartzone: opt("smartzone", own.smartzone ?? !!ai.smartzone) },
    here: Object.keys(own).length,
  };
}
