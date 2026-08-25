// Run: node bridge/miniapp/web/src/lib/cardfields.check.ts
import {
  asChain, asChart, asChecks, asClaims, asCommands, asConfidence, asDiff, asFiles,
  asFindings, asGraph, asIdeas, asIntake, asMeters, asOutput, asPlan, asScreens,
  asSources, asStats, asTable,
  diffColor, flatten, handoffPrompt, triagePrompt,
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

// --- the widget grammar ----------------------------------------------------
console.assert(asDiff([{ file: "a.py", add: 4, del: 1 }])?.[0].add === 4, "a diff row keeps its stat");
console.assert(asDiff([{ path: "a.py" }])?.[0].file === "a.py", "path is accepted for file");
console.assert(asDiff([{ add: 2 }]) === null, "a fileless diff row drops the widget");
console.assert(asDiff([{ file: "a.py", hunk: "@@ x\n- a\n+ b" }])?.[0].hunk?.includes("+ b"), "the hunk survives");

console.assert(diffColor("+ added") === "var(--ok)", "an add is green");
console.assert(diffColor("- gone") === "var(--err)", "a delete is red");
console.assert(diffColor("--- a/x.py") === "var(--txl)", "a header is not a whole-file delete");
console.assert(diffColor("@@ ctx") === "var(--acc)", "a hunk header leads");

console.assert(asOutput("41 passed")?.text === "41 passed", "a bare string is output");
console.assert(asOutput({ cmd: "pytest", text: "ok", ok: true })?.ok === true, "the lamp survives");
console.assert(asOutput({ cmd: "pytest" }) === null, "a command with no output has nothing to draw");
console.assert(asOutput("   ") === null, "whitespace is not output");

const g = asGraph({
  nodes: [{ id: "a", label: "TELEGRAM", state: "ok" }, { id: "b", label: "BRIDGE" }],
  edges: [{ from: "a", to: "b", label: "34ms" }, { from: "a", to: "ghost" }],
});
console.assert(g?.nodes.length === 2 && g.edges.length === 1, "an edge into nowhere is dropped");
console.assert(g?.nodes[0].state === "ok" && g.nodes[1].state === undefined, "only a known state survives");
console.assert(asGraph({ nodes: [] }) === null, "a map needs nodes");
console.assert(asGraph({ nodes: [{ label: "LONE" }] })?.nodes[0].id === "LONE", "a label stands in for an id");

console.assert(asChain([{ label: "SYMPTOM", body: "boom", tone: "bad" }])?.[0].tone === "bad", "a step keeps its tone");
console.assert(asChain([{ label: "CAUSE", body: "x", tone: "spicy" }])?.[0].tone === "flat", "an unknown tone is flat");
console.assert(asChain([{ body: "no label" }]) === null, "a step needs a label");

console.assert(asChart([{ label: "08-22", value: 96.4 }])?.[0].value === 96.4, "a bar reads");
console.assert(asChart([{ label: "08-22", value: "96.4" }]) === null, "a stringy value is not a number");
console.assert(asStats([{ label: "AVG", value: "61.4M" }])?.[0].value === "61.4M", "the model's formatting survives");
console.assert(asStats([{ label: "TURNS", value: 56 }])?.[0].value === "56", "a numeric stat still prints");

const t = asTable({ cols: ["DAY", "TOK"], rows: [["08-22", "96.4M"], ["08-23"]] });
console.assert(t?.rows[1][1] === "", "a short row is padded, not dropped");
console.assert(asTable({ cols: [], rows: [[1]] }) === null, "a table needs columns");
console.assert(asTable({ cols: ["A"], rows: ["nope"] }) === null, "a row must be a row");

console.assert(asIdeas([{ title: "Gallery", picked: true }])?.[0].picked === true, "a picked idea stays picked");
console.assert(asIdeas([{ note: "no title" }]) === null, "an idea needs a title");

console.assert(asMeters([{ label: "CPU", pct: 12 }])?.[0].pct === 12, "a meter reads");
console.assert(asMeters([{ label: "MEM", pct: "63%" }])?.[0].pct === 63, "a percentage string scales");
console.assert(asMeters([{ label: "DISK", pct: 140 }])?.[0].pct === 100, "over full is full");
console.assert(asMeters([{ label: "X", pct: -1 }]) === null, "a negative is not a meter");

console.assert(asPlan([{ op: "+", text: "unit" }])?.[0].op === "add", "a sign is a verb");
console.assert(asPlan([{ op: "REMOVE", text: "cron" }])?.[0].op === "drop", "a word is the same verb");
console.assert(asPlan([{ op: "maybe", text: "x" }]) === null, "an unknown verb drops the plan");

console.assert(asSources([{ title: "core.telegram.org", badge: "official" }])?.[0].badge === "official", "a badge survives");
console.assert(asSources([{ url: "https://x.dev" }])?.[0].title === "https://x.dev", "a url stands in for a title");
console.assert(asSources([{ title: "old", stale: true }])?.[0].stale === true, "dated is flagged");

console.assert(asClaims([{ text: "webhooks win", cites: [1, 2] }])?.[0].cites.length === 2, "citations carry");
console.assert(asClaims([{ text: "no source" }])?.[0].cites.length === 0, "an uncited claim still draws");
console.assert(asClaims([{ text: "x", cites: [0, "2", "nope"] }])?.[0].cites.join() === "2", "only real keys cite");
console.assert(asClaims([{ cites: [1] }]) === null, "a claim needs text");

const q = asIntake([{ topic: "AUDIENCE", ask: "who is this for?", options: ["new", "returning"] }]);
console.assert(q?.[0].options.length === 2, "options carry");
console.assert(asIntake([{ question: "where?" }])?.[0].ask === "where?", "question is accepted for ask");
console.assert(asIntake([{ topic: "X" }]) === null, "a question needs something asked");
console.assert(asIntake([{ ask: "depth?", answer: "guided" }])?.[0].answer === "guided", "an answer is kept");

console.log("cardfields: ok");
