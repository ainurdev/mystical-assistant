// Run: node bridge/dashboard/web/src/lib/planline.check.ts
import { planHead, planSay, type PlanEv } from "./planline.ts";

const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`FAIL: ${what} — got ${JSON.stringify(got)}`);
  console.log(`ok - ${what}`);
};
const ev = (over: Partial<PlanEv>): PlanEv => ({ type: "plan", first: false, done: 3, total: 10, steps: [], changes: [], more: 0, ...over });
eq(planHead(ev({ first: true, total: 1 })), "Made a plan: 1 step", "a first plan, one step");
eq(planHead(ev({})), "Plan · 3 of 10 done", "a change says how far it is");
eq(planSay({ kind: "done", n: 4, id: "s4", title: "Stage" }), "Step 4 done: Stage", "done");
eq(planSay({ kind: "removed", n: null, id: "s9", title: "Old" }), "Dropped a step: Old", "a step gone has no number");
eq(planSay({ kind: "substeps", n: 2, id: "s2", title: "x", done: 1, of: 3 }), "Step 2: 1 of 3 sub-steps done", "sub-steps");
