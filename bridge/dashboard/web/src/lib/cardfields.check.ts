// Run: node bridge/dashboard/web/src/lib/cardfields.check.ts
import {
  asChecks, asCommands, asConfidence, asFiles, asFindings, asScreens,
  flatten, handoffPrompt, triagePrompt,
} from "./cardfields.ts";

// --- guards: the promised shape, or null so the field renders as text -------
console.assert(asChecks([{ cmd: "pytest -q", ok: true }])?.[0].ok === true, "a check row reads");
console.assert(asChecks([{ cmd: "pytest", ok: true }, { cmd: "tsc" }]) === null, "one bad row drops the board");
console.assert(asChecks("pytest passed") === null, "prose is not a board");
console.assert(asChecks([]) === null, "an empty list has nothing to draw");

console.assert(asFindings([{ file: "a.py", severity: "HIGH", note: "leak" }])?.[0].severity === "high", "severity is normalized");
console.assert(asFindings([{ file: "a.py", severity: "spicy", note: "x" }])?.[0].severity === "med", "an unknown severity lands in the middle");
console.assert(asFindings([{ line: 3, note: "x" }]) === null, "a finding needs a file");

console.assert(asFiles(["a.py", "b.py"])?.length === 2, "plain paths are files");
console.assert(asFiles([{ path: "a.py", add: 4, del: 1 }])?.[0].add === 4, "a diffstat survives");
console.assert(asFiles(["a.py", { add: 2 }]) === null, "a pathless object drops the chips");

console.assert(asCommands([{ cmd: "systemctl restart x", status: "ok" }])?.[0].status === "ok", "a command row reads");
console.assert(asCommands([{ cmd: "x", status: "weird" }])?.[0].status === undefined, "an unknown status is just absent");
console.assert(asScreens([{ path: "/tmp/a.png" }])?.length === 1, "a screen needs only its path");

console.assert(asConfidence(0.8) === 0.8, "a fraction passes through");
console.assert(asConfidence("80%") === 0.8, "a percentage string scales down");
console.assert(asConfidence(80) === 0.8, "a bare percentage scales down");
console.assert(asConfidence("high") === null, "a word is not a meter");
console.assert(asConfidence(140) === null, "over 100 is not a confidence");

// --- flatten: the text fallback, matching flow._flat -----------------------
console.assert(flatten(true) === "✓" && flatten(false) === "✗", "bools are glyphs");
console.assert(flatten(["a.py", "b.py"]) === "a.py, b.py", "a list reads as a list");
console.assert(flatten([{ cmd: "pytest -q", ok: true }]) === "pytest -q ✓", "a row prints its values, not its JSON");
console.assert(flatten(undefined) === "—", "nothing reads as nothing");

// --- prompts ---------------------------------------------------------------
const brief = handoffPrompt(
  { stage: "report", summary: "the queue drops jobs", fields: { answer: "a race", confidence: 0.8 } },
  "PROBE",
);
console.assert(brief.startsWith("[from PROBE REPORT] the queue drops jobs"), `handoff header: ${brief}`);
console.assert(brief.includes("ANSWER: a race"), "fields carry into the brief");

const tri = triagePrompt(
  [{ file: "a.py", line: 3, severity: "high", note: "leak" },
   { file: "b.py", severity: "low", note: "nit" }],
  new Set([1]),
);
console.assert(tri.includes("keeping 1, dropping 1"), `triage counts: ${tri}`);
console.assert(tri.includes("- a.py:3 — leak") && tri.includes("- b.py — nit"), "both sides are named");

console.log("cardfields: ok");
