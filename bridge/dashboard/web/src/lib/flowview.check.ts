// Run: node bridge/dashboard/web/src/lib/flowview.check.ts
import { flowChip, flowView, type Flow } from "./flowview.ts";
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

// The bridge's own steps (REVIEW and AUDIT while PONYTAIL is on), skipped ones, and the FLOW chip.
const here: Flow = { ...flow("feature-here", ["grill", "build-here"]), skipped: [], overrides: {},
  stations: [["grill", "grill-with-docs", "you"], ["build-here", "implement", "auto"], ["review", "ponytail-review", "auto"],
    ["retro", "retro", "auto"], ["audit", "ponytail-audit", "auto"]] };
const hv = flowView(here, []);
console.assert(hv.total === 5 && hv.stations.map((x) => x.key).join() === "grill,build-here,review,retro,audit", `the bridge's steps: ${hv.stations.map((x) => x.key)}`);
const c = flowChip(here, hv, { autopick: true, smartzone: true })!;
console.assert(c.label === "feature here" && c.next.label === "review" && c.mark === "auto" && c.step === 3 && c.total === 5, `chip: ${JSON.stringify(c)}`);
console.assert(c.skipTo === "retro" && c.jumps.map((j) => j.key).join() === "retro,audit", `skip and jump: ${c.skipTo} ${c.jumps.map((j) => j.key)}`);
console.assert(c.here === 0 && c.opts.autopick.on && !c.opts.autopick.here && c.opts.nextstep.on, "nothing set here: SETTINGS' values");
const held = flowChip({ ...here, auto: false, overrides: { nextstep: false, autopick: false } }, hv, { autopick: true, smartzone: true })!;
console.assert(held.mark === "held" && held.here === 2 && held.opts.nextstep.here && !held.opts.autopick.on && held.opts.autopick.global, `held: ${JSON.stringify(held)}`);
const busy = flowChip(here, flowView(here, [run]), {})!;
console.assert(busy.next.label === "retro" && busy.skipTo === "audit", `a step running: the chip names the one after it (${busy.next.label})`);
const last = flowChip({ ...here, done: ["grill", "build-here", "review", "retro"] }, flowView({ ...here, done: ["grill", "build-here", "review", "retro"] }, []), {})!;
console.assert(last.next.label === "audit" && last.skipTo === "" && last.jumps.length === 0, "the last step: SKIP ends the path");
console.assert(flowChip({ ...here, done: ["grill", "build-here", "review", "retro", "audit"] }, flowView({ ...here, done: ["grill", "build-here", "review", "retro", "audit"] }, []), {}) === null, "complete: no chip");
console.assert(flowChip(flow("feature-here", ["grill"]), flowView(flow("feature-here", ["grill"]), []), {}) === null, "an older bridge: no chip");
const sk = flowView({ ...here, done: ["grill", "build-here", "review"], skipped: ["review"] }, []);
console.assert(sk.stations[2].skipped && sk.stations[2].state === "done" && !sk.stations[1].skipped, "a skipped step is done, and says so");
const tk = { ...flow("feature", ["grill", "spec", "tickets"]), overrides: {} };
const away = flowChip(tk, flowView(tk, [], building), {})!;
console.assert(away.next.label === "merge" && away.skipTo === null && away.jumps.length === 0, "tickets building: no skipping past them");
