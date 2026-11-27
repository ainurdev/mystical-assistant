// Run: node bridge/dashboard/web/src/lib/flowview.check.ts
import { flowChip, flowGlobals, flowLabel, flowOf, flowView, movesElsewhere, runningFlow, startedBy, type Flow } from "./flowview.ts";
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
// A set stopped on a fix is the user's: nothing runs, and what is left waits behind it.
const held = flowView(atBuild, [], { status: "building", tickets: { "01": { status: "done" }, "02": { status: "fix" }, "03": { status: "queued" } } });
console.assert(held.stations[3].state === "you" && held.note === "1 of 3 tickets done, 0 running, 1 needs a fix", `held: ${held.stations[3].state} ${held.note}`);
const partly = flowView(atBuild, [], { status: "building", tickets: { "01": { status: "running" }, "02": { status: "fix" }, "03": { status: "fix" } } });
console.assert(partly.stations[3].state === "now" && partly.note === "0 of 3 tickets done, 1 running, 2 need a fix", `a fix beside a running ticket: ${partly.note}`);
const mfix = flowView(flow("feature", ["grill", "spec", "tickets", "build"]), [], { status: "fix", tickets: {} });
console.assert(mfix.stations[4].state === "you" && mfix.note === "the merge needs a fix", `merge fix: ${mfix.stations[4].state} ${mfix.note}`);
const off = flowView(atBuild, [], null, false);
console.assert(off.stations[3].state === "you" && off.stations[3].who === "you", "TICKETS off: BUILD waits for you");
console.assert(off.stations[4].who === "you", "TICKETS off: MERGE is yours too");
console.assert(flowView(atBuild, [], building, false).stations[3].state === "now", "a set already building still shows running");
console.assert(flowView(atBuild, [], { ...building, flow_at: 2 }).stations[3].state === "auto", "a set built for an earlier path is not this one's");
console.assert(flowView(atBuild, [], { ...building, flow_at: 1 }).stations[3].state === "now", "the set this path built is");

// AUTO-START off: the set waits on the user's tap.
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
const here: Flow = { ...flow("build-here", ["grill", "build-here"]), skipped: [], overrides: {},
  stations: [["grill", "grill-with-docs", "you"], ["build-here", "implement", "auto"], ["review", "ponytail-review", "auto"],
    ["retro", "retro", "auto"], ["audit", "ponytail-audit", "auto"]] };
const hv = flowView(here, []);
console.assert(hv.total === 5 && hv.stations.map((x) => x.key).join() === "grill,build-here,review,retro,audit", `the bridge's steps: ${hv.stations.map((x) => x.key)}`);
const c = flowChip(here, hv, { autopick: true, smartzone: true })!;
console.assert(c.label === "BUILD" && c.flow === "build" && c.next.label === "review" && c.mark === "auto" && c.step === 3 && c.total === 5, `chip: ${JSON.stringify(c)}`);
console.assert(c.skipTo === "retro" && c.jumps.map((j) => j.key).join() === "retro,audit", `skip and jump: ${c.skipTo} ${c.jumps.map((j) => j.key)}`);
console.assert(c.here === 0 && c.opts.autopick.on && !c.opts.autopick.here && c.opts.nextstep.on, "nothing set here: SETTINGS' values");
const heldChip = flowChip({ ...here, auto: false, overrides: { nextstep: false, autopick: false } }, hv, { autopick: true, smartzone: true })!;
console.assert(heldChip.mark === "held" && heldChip.here === 2 && heldChip.opts.nextstep.here && !heldChip.opts.autopick.on && heldChip.opts.autopick.global, `held: ${JSON.stringify(heldChip)}`);
console.assert(flowChip({ ...here, overrides: { designpack: true } }, hv, {})!.here === 0, "DESIGN PACK's override isn't one the chip counts or resets");
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
const skilled: Flow = { ...flow("bug", ["diagnose"]), stations: [["diagnose", "diagnosing-bugs", "auto"], ["review", "some-review", "auto"], ["retro", "retro", "auto"]] };
console.assert(flowView(skilled, [run]).stations[1].state === "now", "a review with a skill runs here");

// When FLOW reads the path again with no turn here: tickets build or merge, a council runs, or a
// REVIEW is about to start by itself. A council that stopped, or a held step, moves nothing.
console.assert(movesElsewhere(atBuild, building) && movesElsewhere(atBuild, { status: "merging", tickets: {} }), "tickets building or merging move it");
console.assert(!movesElsewhere(atBuild, null) && !movesElsewhere(null, null), "no set, no path: nothing moves");
console.assert(movesElsewhere(atReview, council("reviewing", 2)) && movesElsewhere({ ...atReview, auto: false }, council("fixing", 1)), "a council that runs moves it, held or not");
console.assert(!movesElsewhere(atReview, council("stopped", 2)), "a council that stopped waits on you");
console.assert(movesElsewhere(atReview, council("idle", 0)), "a REVIEW about to start moves it");
console.assert(!movesElsewhere({ ...atReview, auto: false }, council("idle", 0)) && !movesElsewhere(atReview, council("idle", 0), false), "a held REVIEW starts nothing by itself");

// The chip and SESSION ▸ FLOW name the flow: a here or tickets variant is its flow, an older bridge's names too.
console.assert(["design-here", "build", "refactor", "fix", "ship", "ask"].map((p) => flowLabel({ path: p })).join() === "DESIGN,BUILD,REFACTOR,FIX,SHIP,ASK", "the six names");
console.assert(flowLabel({ path: "feature-here" }) === "BUILD" && flowLabel({ path: "bug" }) === "FIX", "an older bridge's names");
console.assert(flowLabel({ path: "one", skill: "implement" }) === "implement" && flowOf("one") === null, "a one-skill path names its skill");
const fixChip = flowChip({ ...skilled, overrides: {} }, flowView(skilled, []), {})!;
console.assert(fixChip.label === "FIX" && fixChip.flow === "fix" && fixChip.next.label === "review", `FIX · REVIEW: ${JSON.stringify(fixChip)}`);

// --- the row's dot: the flow runs until its last step is done ------------------------
{
  const st: Flow["stations"] = [["grill", "grill-with-docs", "you"], ["build-here", "implement", "auto"]];
  const f = (path: string, done: string[]) => ({ path, by: "you", why: "you picked BUILD", auto: true, at: 1, done, next: null, stations: st }) as Flow;
  console.assert(runningFlow(f("build-here", ["grill"])) === "build", "a here build is BUILD's dot");
  console.assert(runningFlow(f("build", ["grill", "build-here"])) === null, "no dot once the last step is done");
  console.assert(runningFlow(null) === null && runningFlow(f("one", [])) === null, "no flow, or one skill: no dot");
  console.assert(startedBy("you", "you picked BUILD") === "you picked BUILD", "a tap says who");
  console.assert(startedBy("guess", "the box guessed BUILD") === "the box guessed BUILD", "a guess says who");
  console.assert(startedBy("claude", "new feature") === "Claude picked it: new feature", "Claude's pick");
}

// flow-gear 05: the chip's SETTINGS values are the session's flow's NEXT and TICKETS, BUILD's with none
{
  const cfg = { flows: [{ id: "build", next: true, tickets: true }, { id: "refactor", next: false, tickets: false }, { id: "fix", next: false }] };
  const g = (path: string | null) => flowGlobals(path ? { path } as Flow : null, cfg, { nextstep: false, ticketruns: false });
  console.assert(JSON.stringify(g("refactor")) === JSON.stringify({ nextstep: false, ticketruns: false }), "REFACTOR's own");
  console.assert(g("build-here").nextstep && g("build-here").ticketruns, "a here build is BUILD's");
  console.assert(g("one").nextstep && g(null).ticketruns, "a one-skill run, or no flow: BUILD's");
  console.assert(!g("fix").ticketruns, "FIX builds no tickets");
  console.assert(flowGlobals(null, null, { nextstep: true }).nextstep, "an older bridge: the old switches");
}
