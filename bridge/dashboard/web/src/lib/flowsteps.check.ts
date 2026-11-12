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
