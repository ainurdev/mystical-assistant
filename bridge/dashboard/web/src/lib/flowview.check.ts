// Run: node bridge/dashboard/web/src/lib/flowview.check.ts
import { flowView, type Flow } from "./flowview.ts";
import type { Turn } from "../chat.ts";

const flow = (path: string, done: string[]): Flow => ({ path, by: "claude", why: "new feature", auto: true, at: 1, done, next: null });
const run = { id: "t", prompt: "", status: "running", pending: [], started: 100, events: [
  { type: "tool", name: "Read", summary: "a.ts" }, { type: "tool", name: "Write", summary: "SPEC.md" }, { type: "text", text: "hi" }] } as unknown as Turn;

const f = flowView(flow("feature", ["grill"]), [run]);
const s = f.stations.map((x) => x.state).join();
console.assert(s === "done,now,you,auto,auto,auto", `feature: ${s}`);
console.assert(f.step === 2 && f.total === 6, `step ${f.step} of ${f.total}`);
console.assert(f.why === "new feature" && f.by === "claude", "why and by");
console.assert(f.nowTurn?.tools === 2 && f.nowTurn.started === 100 && f.nowTurn.activity === "Write · SPEC.md", `nowTurn ${JSON.stringify(f.nowTurn)}`);

const idle = flowView(flow("feature", ["grill"]), []);
console.assert(idle.stations.map((x) => x.state).join() === "done,auto,you,auto,auto,auto" && !idle.nowTurn, "idle: the waiting step shows its own kind");
console.assert(flowView(flow("feature-here", []), []).stations.length === 3, "feature-here has 3");
console.assert(flowView(flow("bug", ["diagnose", "fix", "retro"]), []).step === 3, "all done keeps step at total");
const none = flowView(null, [run]);
console.assert(none.stations.length === 0 && none.step === 0 && none.total === 0, "null flow: nothing");

const one = { ...flow("one", []), skill: "research" };
console.assert(flowView(one, []).stations[0].label === "research", "one path: labelled by its skill");
console.assert(flowView({ ...one, done: ["research"] }, []).stations[0].state === "done", "one path: done matches the skill");
