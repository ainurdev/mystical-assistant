import type { FlowSettings, FlowStep } from "../api.ts";
import { promptSteps, runs } from "./flowsteps.ts";

const step = (s: string, on = true, ponytail_off: FlowStep["ponytail_off"] = false): FlowStep => ({ step: s, fixed: false, on, ponytail_off });
const flow = (id: string, steps: FlowStep[]) => ({ id, on: true, next: true, run: { model: "", mode: "", effort: "", trim: "" }, run_saved: false, steps });
const cfg = {
  on: true, autopick: false, smartzone: false, guess: "auto", nokind: "claude", presets: false,
  flows: [
    flow("build", [step("grill"), step("build"), step("review", true, "here"), step("retro"), step("audit", false)]),
    flow("fix", [step("diagnose"), step("review", true, true), step("retro")]),
    flow("ask", [step("answer")]),
  ],
} as FlowSettings;

// A switched-off step and PONYTAIL's own while it is off don't run; a here build's REVIEW may (the council's).
console.assert(!runs(step("audit", false)) && !runs(step("review", true, true)) && runs(step("review", true, "here")), "runs");

const at = (kind: string | null, how: "auto" | "picked" | "plain" | "none", running: string | null = null) =>
  promptSteps({ kind, how, running, cfg });
console.assert(at("build", "picked") === "grill › build › review › retro", "a tapped BUILD: its steps, AUDIT off left out");
console.assert(at("fix", "auto") === "diagnose › retro", "a guessed FIX at the start: PONYTAIL off leaves its REVIEW out");
console.assert(at("ask", "auto", "build") === "grill › build › review › retro", "a guess during a running flow: the running flow's steps");
console.assert(at("ask", "picked", "build") === "answer", "a tap during a running flow: the tapped flow's (it replaces the running one)");
console.assert(at(null, "none", "build") === null, "nothing lit: no steps");
console.assert(promptSteps({ kind: "build", how: "picked", running: null, cfg: null }) === null, "bridge not answered yet");
console.assert(at("design", "picked") === null, "a flow the bridge didn't name");

// Every step the bridge names (bridge/flowsettings.py STEPS) has the FLOWS sheet's one-line purpose.
// The pre-commit hook checks a copy of the web folders alone, without the bridge: it skips there.
const PY = new URL("../../../../flowsettings.py", import.meta.url);
if (!(await import("node:fs")).existsSync(PY)) console.log("flowsteps.check: no bridge/flowsettings.py here, STEP_DOES not compared");
else {
  const { readFileSync } = await import("node:fs");
  const { STEP_DOES } = await import("./flowsteps.ts");
  const py = readFileSync(PY, "utf8");
  const block = py.slice(py.indexOf("STEPS = {"), py.indexOf("}", py.indexOf("STEPS = {")));
  const names = new Set([...block.matchAll(/\("(\w+)", (?:True|False)\)/g)].map((m) => m[1]));
  console.assert(names.size >= 8, `read the bridge's steps (${[...names]})`);
  for (const n of names) console.assert(!!STEP_DOES[n], `STEP_DOES has ${n}`);
}
