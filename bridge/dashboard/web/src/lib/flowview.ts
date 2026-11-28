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
   So is a set that stopped on a fix: no ticket runs and the rest wait behind it.
   The REVIEW after MERGE is the council's, in the merge session: the set carries
   that council's run, and one that stopped waits on you. */

/** Who started the path: a rule (a typed /command), Claude, a tap in the prompt box, or its guess. */
export type FlowBy = "rule" | "claude" | "you" | "guess";
/** The SETTINGS switches one session overrides from the prompt box's FLOW chip (bridge/paths.py OPTIONS). */
export type FlowOption = "nextstep" | "autopick" | "smartzone";
export interface Flow {
  path: string; skill?: string | null; by: FlowBy; why: string; auto: boolean; at: number;
  done: string[]; next: { station: string; turn_id: string; started?: boolean } | null;
  /** Switches set in this session over SETTINGS; a bridge older than the FLOW chip sends none. */
  overrides?: Partial<Record<FlowOption | "designpack", boolean>>;   // DESIGN PACK's: set by the API, not the chip
  /** Steps passed over with SKIP or JUMP TO (they're in `done` too). */
  skipped?: string[];
  /** The path's steps as the bridge runs them: ponytail's REVIEW and AUDIT only while
      PONYTAIL is on, the council's REVIEW (no skill) only where it follows MERGE. */
  stations?: [string, string | null, "you" | "auto"][];
  /** When its last step was done; null while it runs (a bridge older than SESSION ▸ FLOWS sends none). */
  end?: number | null;
}
/** A flow the session ran before its current one (GET /local/flow `past`, oldest first). */
export interface PastFlow extends Pick<Flow, "path" | "skill" | "by" | "why" | "at" | "done" | "skipped" | "stations"> {
  /** When it ended: its last step done, or another flow took its place. */
  end: number;
  /** The step it was on when another flow took its place; null when it ran to its end. */
  stopped: string | null;
}
/** The flow's ticket set, as GET /local/flow sends it (bridge/tickets.py flow_set). `review` is the
    council's run in the merge session, sent once the set is merged. */
export interface FlowSet {
  status: string; error?: string; flow_at?: number; tickets: Record<string, { status: string }>;
  review?: Pick<CouncilBrief, "status" | "reason" | "round" | "max_rounds">;
}
export type StationState = "done" | "now" | "you" | "auto" | "next";
export interface FlowView {
  stations: { key: string; label: string; skill: string | null; who: "you" | "auto"; state: StationState; skipped?: boolean }[];
  step: number; total: number; why: string; by: FlowBy;
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

// The six flows (bridge/paths.py FLOWS), and the names an older bridge's records carry.
const FLOWS = ["design", "build", "refactor", "fix", "ship", "ask"];
const OLD: Record<string, string> = { feature: "build", bug: "fix" };

/** The flow a path is: a here or tickets variant ("build-here") is its flow; null for a one-skill path. */
export function flowOf(path: string): string | null {
  const id = path.split("-")[0];
  const f = OLD[id] ?? id;
  return FLOWS.includes(f) ? f : null;
}

/** The SETTINGS values a session's flow reads (bridge/paths.py flow_id): its flow's NEXT and TICKETS,
    BUILD's for a one-skill run or no flow; the old switches from a bridge older than the FLOWS sheet. */
export function flowGlobals(flow: Flow | null, cfg: { flows: { id: string; next: boolean; tickets?: boolean }[] } | null,
  ai: Partial<Record<string, boolean>>): { nextstep: boolean; ticketruns: boolean } {
  const f = cfg?.flows.find((x) => x.id === ((flow && flowOf(flow.path)) || "build"));
  return f ? { nextstep: f.next, ticketruns: !!f.tickets } : { nextstep: !!ai.nextstep, ticketruns: !!ai.ticketruns };
}

/** The flow the session is on until its last step is done (the row's dot), else null. */
export function runningFlow(flow: Flow | null): string | null {
  return flow && (flow.stations ?? []).some(([k]) => !flow.done.includes(k)) ? flowOf(flow.path) : null;
}

/** Who started the path, as SESSION ▸ FLOW says it. A start from the box already says who in
    its why ("you picked BUILD", "the box guessed BUILD"). */
export function startedBy(by: FlowBy, why: string): string {
  return by === "you" || by === "guess" ? why : `${by === "claude" ? "Claude" : "A rule"} picked it: ${why}`;
}

/** What FLOW names a path: its flow's name ("BUILD"), or a one-skill path's skill. */
export function flowLabel(flow: Pick<Flow, "path" | "skill">): string {
  return flowOf(flow.path)?.toUpperCase() ?? flow.skill ?? "one skill";
}

/** Whether the path can move with no turn in this session, so FLOW has to read it again by
    itself: tickets build or merge, a council runs, or a REVIEW is about to start. A council that
    stopped stays put until you act on it, and a held step starts nothing (`nextstep` is AUTO NEXT STEPS). */
export function movesElsewhere(flow: Flow | null, set: FlowSet | null, nextstep = true): boolean {
  if (set?.status === "building" || set?.status === "merging") return true;
  if (flow?.next?.station !== "review") return false;
  const council = set?.status === "merged" ? set.review : undefined;
  return !!council && live(council) || council?.status !== "stopped" && flow.auto && nextstep;
}

export function flowView(flow: Flow | null, turns: Turn[], set: FlowSet | null = null, ticketruns = true): FlowView {
  if (!flow) return { stations: [], step: 0, total: 0, why: "", by: "rule" };
  if (set?.flow_at !== undefined && set.flow_at !== flow.at) set = null;   // built for an earlier path here
  const table = flow.stations ?? PATHS[flow.path] ?? [[flow.skill ?? "skill", flow.skill ?? null, "auto"] as [string, string | null, "you" | "auto"]];
  const running = [...turns].reverse().find((t) => t.status === "running");
  const first = table.findIndex(([k]) => !flow.done.includes(k));
  const council = set?.status === "merged" ? set.review : undefined;
  const tks = Object.values(set?.tickets ?? {});
  const fix = tks.filter((t) => t.status === "fix").length;
  // a fix with nothing running: every ticket left waits behind it, so BUILD is yours (Retry in TICKETS)
  const held = set?.status === "building" && fix > 0 && !tks.some((t) => t.status === "running" || t.status === "retry");
  const elsewhere: Record<string, boolean> = { build: set?.status === "building" && !held, merge: set?.status === "merging",
    review: !!council && live(council) };
  const approving = set?.status === "approve";   // AUTO-START off: the set waits for the user's tap
  const yours = held || approving ? "build" : set?.status === "fix" ? "merge" : "";
  const stations = table.map(([key, skill, kind], i) => {
    // a started step with no turn running ended without StepDone (a question): it waits on you
    const asked = i === first && !running && !!flow.next?.started && flow.next.station === key;
    const who = !ticketruns && (key === "build" || key === "merge") || key === yours || asked
      || key === "review" && council?.status === "stopped" ? "you" : kind;
    // only a step with no skill runs elsewhere: a review that has one is a turn in this session
    const now = skill === null && key in elsewhere ? elsewhere[key] : i === first && !!running;
    return { key, label: key.replace(/-/g, " "), skill, who, state: (flow.done.includes(key) ? "done" : now ? "now" : who) as StationState,
      skipped: !!flow.skipped?.includes(key) };
  });
  const note = approving ? "waiting for your approval" : set?.status === "building" ? `${tks.filter((t) => t.status === "done").length} of ${tks.length} tickets done, ${tks.filter((t) => t.status === "running").length} running${fix ? `, ${fix} need${fix === 1 ? "s" : ""} a fix` : ""}`
    : set?.status === "merging" ? "one session merges the tickets"
    : set?.status === "fix" ? "the merge needs a fix"
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

/** A past flow's steps as SESSION ▸ FLOWS draws them: done (or skipped), the one it
    stopped on, and the rest it never reached. */
export function pastSteps(f: PastFlow): { key: string; label: string; skill: string | null; state: "done" | "stopped" | "next"; skipped: boolean }[] {
  return (f.stations ?? []).map(([key, skill]) => ({ key, label: key.replace(/-/g, " "), skill,
    state: f.done.includes(key) ? "done" : key === f.stopped ? "stopped" : "next", skipped: !!f.skipped?.includes(key) }));
}

/** What the prompt box's FLOW chip shows (Composer): the step that comes next, whether it
    starts by itself, the three switches this session may set, and where SKIP and JUMP TO
    land. null with no path, with nothing left to start, or on a bridge older than the chip
    (it can't hold a switch per session). */
export interface FlowChip {
  /** The flow's name ("BUILD"), or a one-skill path's skill; `flow` is its id, null for one skill. */
  label: string; flow: string | null;
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
    label: flowLabel(flow), flow: flowOf(flow.path),
    step: v.step, total: v.total,
    next: { key: rest[0].key, label: rest[0].label },
    mark: rest[0].who === "you" ? "you" : flow.auto ? "auto" : "held",
    skipTo: away ? null : rest[1]?.key ?? "",
    jumps: away ? [] : rest.slice(1).map((s) => ({ key: s.key, label: s.label })),
    opts: { nextstep: opt("nextstep", flow.auto), autopick: opt("autopick", own.autopick ?? !!ai.autopick),
            smartzone: opt("smartzone", own.smartzone ?? !!ai.smartzone) },
    here: (["nextstep", "autopick", "smartzone"] as const).filter((k) => k in own).length,
  };
}
