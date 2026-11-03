// Run: node bridge/dashboard/web/src/lib/goal.check.ts
import { goalPhase, goalTurns, spanTime, barTime } from "./goal.ts";
import type { Goal } from "../api.ts";
import type { Turn } from "../chat.ts";

const g: Goal = { objective: "x", state: "active", iter: 2, since: 1000 };
const t = (id: string, started: number, elapsed: number | null, status: Turn["status"] = "done") =>
  ({ id, prompt: "", events: [], pending: [], status, started, elapsed }) as Turn;
const turns = [
  t("old", 100, 100),          // over before the goal was set
  t("set", 400, 900),          // running when CreateGoal ran: it counts, as the first
  t("auto1", 1400, 2700),
  t("auto2", 4200, null, "running"),
];

// --- goalTurns ----------------------------------------------------------------
const gt = goalTurns(g, turns, 4500)!;
console.assert(gt.map((x) => x.id).join() === "set,auto1,auto2", `the goal's turns: ${gt.map((x) => x.id)}`);
console.assert(gt[0].first && !gt[1].first, "the turn that set it is the first");
console.assert(gt[2].live && gt[2].secs === 300, "a running turn counts up to now");
console.assert(goalTurns({ ...g, since: undefined }, turns, 0) === null, "an old goal has no turns to show");
const met = goalTurns({ ...g, state: "complete", at: 2000 }, turns, 4500)!;
console.assert(met.map((x) => x.id).join() === "set,auto1", "nothing after the verdict");

// --- goalPhase ----------------------------------------------------------------
console.assert(goalPhase(g, true, 0, 10) === "working", "a turn is running");
console.assert(goalPhase(g, false, 5, 10) === "working", "a nudge is about to start");
console.assert(goalPhase(g, false, 30, 10) === "stalled", "quiet with nothing coming");
console.assert(goalPhase({ ...g, iter: 10 }, false, 0, 10) === "stalled", "the brake stopped it");
console.assert(goalPhase({ ...g, iter: 10 }, true, 0, 10) === "working", "its last turn is still running");
console.assert(goalPhase({ ...g, state: "blocked" }, true, 0, 10) === "blocked", "the verdict wins");
console.assert(goalPhase({ ...g, state: "complete", at: 5 }, false, 0, 10) === "met", "met, not yet prompted past");
console.assert(goalPhase({ ...g, state: "complete", at: 5, seen: true }, false, 0, 10) === null, "prompted past it");
console.assert(goalPhase({ ...g, state: "complete" }, false, 0, 10) === null, "an old goal: no at");

// --- times ----------------------------------------------------------------------
console.assert(spanTime(6540) === "1h 49m", spanTime(6540));
console.assert(barTime(3259) === "54m" && barTime(20) === "1m" && barTime(4000) === "1.1h", barTime(4000));
