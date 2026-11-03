// Run: node bridge/dashboard/web/src/lib/savers.check.ts
// Savers: the prompt tag a trial's session wears, and what each card's floor says
// in each mode, before, during and after a trial.
import type { Saver } from "../api.ts";
import { pct, saverFoot, saverTag } from "./savers.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

eq(["concise", "subagent_effort", "trim_tests", "new_one"].map(saverTag),
  ["Concise · trial", "Subagent effort · trial", "Trim tests · trial", "new one · trial"], "the prompt tag per saver");
eq([pct(-41), pct(12), pct(0)], ["−41%", "+12%", "±0%"], "deltas with a real minus");

const trial = (n: number, words: number | null, tokens: number | null) =>
  ({ n, on: Math.ceil(n / 2), off: Math.floor(n / 2), words, tokens, tools: null, errors_on: 0, errors_off: 0 });
const saver = (key: string, mode: Saver["mode"], t: Saver["trial"]): Saver =>
  ({ key, label: key, hint: `the ${key} hint`, mode, target: 20, trial: t });

eq(saverFoot(saver("concise", "trial", trial(14, -41, -9))),
  { left: "trial · 14 of 20 sessions", bar: 0.7, delta: "−41%", good: true, unit: "words", untried: false },
  "a running trial: progress, and Concise's delta in words");
eq(saverFoot(saver("concise", "trial", trial(0, null, null))),
  { left: "trial · 0 of 20 sessions", bar: 0, delta: null, good: null, unit: "words", untried: false },
  "a trial just started: nothing to compare yet");
eq(saverFoot(saver("concise", "trial", trial(23, -30, null))).left, "trial done · 23 sessions", "past the target it says it's done");
eq(saverFoot(saver("subagent_effort", "on", trial(20, 5, -18))),
  { left: "kept after a trial", bar: null, delta: "−18%", good: true, unit: "tokens a turn", untried: false },
  "kept after a trial: the others report tokens");
eq(saverFoot(saver("trim_tests", "off", null)),
  { left: "pytest · vitest · jest · go test", bar: null, delta: null, good: null, unit: "tokens a turn", untried: true },
  "off and never tried: the fact, and not tried yet");
eq(saverFoot(saver("subagent_effort", "on", null)).left, "your own turns keep their effort", "on without a trial: the fact");
eq(saverFoot(saver("trim_tests", "off", trial(20, 0, 7))).good, false, "a saver whose half came out higher is no saving");
eq(saverFoot(saver("brand_new", "off", null)).left, "the brand_new hint", "a saver this page doesn't know falls back to its hint");
