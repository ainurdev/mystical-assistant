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
const bug = flowView(flow("bug", ["diagnose", "retro"]), []);
console.assert(bug.total === 2 && bug.step === 2, `bug is diagnose then retro, and all done keeps step at total: ${bug.step} of ${bug.total}`);
const none = flowView(null, [run]);
console.assert(none.stations.length === 0 && none.step === 0 && none.total === 0, "null flow: nothing");

const one = { ...flow("one", []), skill: "research" };
console.assert(flowView(one, []).stations[0].label === "research", "one path: labelled by its skill");
console.assert(flowView({ ...one, done: ["research"] }, []).stations[0].state === "done", "one path: done matches the skill");

// The ticket set behind BUILD and MERGE (GET /local/flow `set`), and the TICKETS switch.
const atBuild = flow("feature", ["grill", "spec", "tickets"]);
const building = { status: "building", tickets: { "01": { status: "done" }, "02": { status: "running" }, "03": { status: "queued" } } };
const b = flowView(atBuild, [], building);
console.assert(b.stations[3].state === "now" && b.stations[4].state === "auto", `building: BUILD runs (${b.stations.map((x) => x.state).join()})`);
console.assert(b.note === "1 of 3 tickets done, 1 running", `building note: ${b.note}`);
const m = flowView(flow("feature", ["grill", "spec", "tickets", "build"]), [], { status: "merging", tickets: {} });
console.assert(m.stations[4].state === "now" && m.note === "one session merges the tickets", `merging: ${m.note}`);
const stopped = flowView(atBuild, [], { status: "stopped", error: "cycle: #01 → #02 → #01", tickets: {} });
console.assert(stopped.stations[3].state === "auto" && stopped.note === "stopped: cycle: #01 → #02 → #01", `stopped: ${stopped.note}`);
console.assert(flowView(atBuild, [], null).note === undefined, "no set: no note");
const off = flowView(atBuild, [], null, false);
console.assert(off.stations[3].state === "you" && off.stations[3].who === "you", "TICKETS off: BUILD waits for you");
console.assert(off.stations[4].who === "you", "TICKETS off: MERGE is yours too");
console.assert(flowView(atBuild, [], building, false).stations[3].state === "now", "a set already building still shows running");
console.assert(flowView(atBuild, [], { ...building, flow_at: 2 }).stations[3].state === "auto", "a set built for an earlier path is not this one's");
console.assert(flowView(atBuild, [], { ...building, flow_at: 1 }).stations[3].state === "now", "the set this path built is");

// APPROVE BEFORE BUILD: the set waits on the user's tap.
const ap = flowView(atBuild, [], { status: "approve", tickets: {} });
console.assert(ap.stations[3].state === "you" && ap.stations[3].who === "you", `approve: BUILD is yours (${ap.stations.map((x) => x.state).join()})`);
console.assert(ap.note === "waiting for your approval", `approve note: ${ap.note}`);

// A started step whose turn ended with no StepDone (a question) waits on you, not "running".
const asked = flowView({ ...flow("feature", ["grill", "spec", "tickets", "build", "merge"]), next: { station: "retro", turn_id: "t", started: true } }, []);
console.assert(asked.stations[5].state === "you", `retro asked: ${asked.stations[5].state}`);
const answering = flowView({ ...flow("feature", ["grill", "spec", "tickets", "build", "merge"]), next: { station: "retro", turn_id: "t", started: true } }, [run]);
console.assert(answering.stations[5].state === "now", "a running turn is still now");
console.assert(flowView({ ...flow("feature", ["grill"]), next: { station: "spec", turn_id: "t", started: false } }, []).stations[1].state === "auto", "not started: still its own kind");

// The bridge sends the path's steps (`flow.stations`), so REVIEW is drawn only where it follows
// MERGE there. It runs in the merge session: the set's `review` (that session's council) says how.
const steps: Flow["stations"] = [["grill", "grill-with-docs", "you"], ["spec", "to-spec", "auto"], ["tickets", "to-tickets", "you"],
  ["build", null, "auto"], ["merge", null, "auto"], ["review", null, "auto"], ["retro", "retro", "auto"]];
const atReview: Flow = { ...flow("feature", ["grill", "spec", "tickets", "build", "merge"]), stations: steps,
  next: { station: "review", turn_id: "", started: true } };
const council = (status: string, round: number, reason = "") => ({ status: "merged", tickets: {}, review: { status, reason, round, max_rounds: 5 } });
console.assert(flowView(atReview, []).total === 7 && flowView(atReview, []).stations[5].key === "review", "the bridge's steps are the ones drawn");
const reading = flowView(atReview, [], council("reviewing", 2));
console.assert(reading.stations[5].state === "now" && reading.note === "council round 2 of 5", `reviewing: ${reading.stations[5].state}, ${reading.note}`);
const fixing = flowView(atReview, [], council("fixing", 1));
console.assert(fixing.stations[5].state === "now" && fixing.note === "fixing round 1's findings", `fixing: ${fixing.stations[5].state}, ${fixing.note}`);
const halted = flowView(atReview, [run], council("stopped", 2, "round 2 didn't raise the score"));
console.assert(halted.stations[5].state === "you" && halted.stations[5].who === "you", `a stopped council waits on you, whatever runs here: ${halted.stations[5].state}`);
console.assert(halted.note === "stopped: round 2 didn't raise the score", `stopped note: ${halted.note}`);
const passed = flowView({ ...atReview, done: [...atReview.done, "review"], next: { station: "retro", turn_id: "", started: true } }, [], council("passed", 2));
console.assert(passed.stations[5].state === "done" && passed.note === undefined, `passed: ${passed.stations[5].state}, ${passed.note}`);
// A step called review that has a skill runs in this session like any other: its turn is what shows it running.
const here: Flow = { ...flow("bug", ["diagnose"]), stations: [["diagnose", "diagnosing-bugs", "auto"], ["review", "some-review", "auto"], ["retro", "retro", "auto"]] };
console.assert(flowView(here, [run]).stations[1].state === "now", "a review with a skill runs here");
