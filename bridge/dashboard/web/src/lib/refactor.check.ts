// Run: node bridge/dashboard/web/src/lib/refactor.check.ts
// REFACTOR in the row (flow-gear 08): its place, its guess words, and its facts.
import { KINDS, KIND_ORDER, guessKind, kindFacts, nextKind, presetFor, sendPlan } from "./kinds.ts";
import type { FactsCtx } from "./kinds.ts";
import type { GitStatus } from "../api.ts";

const START = { start: true, design: true }, MID = { start: false, design: true };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.assert(KIND_ORDER.join() === "design,build,refactor,fix,ship,ask", "REFACTOR sits after BUILD");
console.assert(KINDS.refactor.name === "REFACTOR" && KINDS.refactor.verb === "Refactor", "its name and verb");
console.assert(same(presetFor("refactor"), presetFor("build")), "REFACTOR's run is BUILD's");

// Real first prompts from bridge.db (read-only), cut to the words the rule reads.
const real: [string, string | null][] = [
  ["refactor permissions system, check the pr and list comments", "refactor"],
  // "refactor" mid-prompt is not the opener: these were a theme change and a mini app rework.
  ["in theme selection separate dark and light theme, after that refactor light theme to texts be more readable", null],
  ["we gonna update mini app interface, also refactor it so its being only a place to give prompts", null],
  // "messy" is not a REFACTOR word: a layout complaint, a question, a design ask and a retry rule.
  ["the number in rightside of chat are messy, too much padding", null],
  ["this doc system is messy, hard to find, what do you suggest for keeping document of a project?", "ask"],
  ["better design for this section, so messy right now", null],
  ["make sure each time 500 error comes, retry so context and session dont get messy", "fix"],
];
for (const [t, k] of real) console.assert(guessKind(t, START) === k, `real: guessKind(${JSON.stringify(t)}) = ${k}, got ${guessKind(t, START)}`);

// Exactly the spec's words: at the start, and two anywhere.
for (const t of ["refactor the session store", "untangle the composer state", "restructure the settings pages", "reorganize the tests folder",
  "reorganise the tests folder", "decouple the runner from the queue", "dedupe the toast helpers", "deduplicate the toast helpers",
  "the composer state is tangled, pull the rail out", "this queue code is spaghetti, split it"])
  console.assert(guessKind(t, START) === "refactor", `${JSON.stringify(t)} lights REFACTOR`);
// Not an opener, not a word of its own, or a name with the word in it.
for (const t of ["add a refactor button to the sheet", "the decoupled runner works fine now", "add tangled-list.tsx to the docs",
  "clean the code in the store", "simplify the runner", "rename the restructure helper", "add a spaghetti/ folder"])
  console.assert(guessKind(t, START) !== "refactor", `${JSON.stringify(t)} is not REFACTOR`);

// Only on a session's first prompt; after ASK, before DESIGN and BUILD; never when switched off.
console.assert(guessKind("refactor the session store", MID) === null, "mid-thread: no REFACTOR, and BUILD no longer opens on refactor");
console.assert(guessKind("refactor the session store?", START) === "ask", "ASK is checked first");
console.assert(guessKind("restyle the spaghetti composer", START) === "refactor", "before DESIGN");
console.assert(guessKind("untangle the broken queue", START) === "fix", "FIX comes before it");
console.assert(guessKind("refactor the session store", { ...START, off: ["refactor"] }) === null, "off: never guessed, and BUILD doesn't take it");
console.assert(guessKind("make the composer less spaghetti", { ...START, off: ["refactor"] }) === "build", "off: the next rule may still fit");
console.assert(guessKind("make the composer less spaghetti", MID) === "build", "mid-thread the anywhere words light nothing new");

// Tab: the flows that are on, REFACTOR after BUILD, then none.
console.assert(nextKind("build", 1) === "refactor" && nextKind("refactor", 1) === "fix", "Tab: build › refactor › fix");
console.assert(nextKind("fix", -1) === "refactor", "Shift-Tab back onto it");
console.assert(nextKind("build", 1, ["refactor"]) === "fix", "off: skipped");
console.assert(nextKind("ask", 1) === null, "then none");

// A tap sends REFACTOR to the bridge, which starts it at improve (bridge/paths.py).
const p = sendPlan({ kind: "refactor", how: "picked", text: "do it", running: null, flows: true, answering: false, agent: false, run: presetFor("refactor") });
console.assert(p.flow === "refactor" && p.by === "you" && p.text === "do it", "a tap starts REFACTOR");

// Its facts beside the row are BUILD's tree fact.
const git = (x: Partial<GitStatus>): GitStatus => ({ is_repo: true, branch: "b", upstream: "origin/x", ahead: 0, behind: 0, dirty: 0, files: [], ...x });
const ctx = (x: Partial<FactsCtx> = {}): FactsCtx => ({ git: git({}), lastCheck: null, designLinked: null, mapBuiltAt: null, pack: true, askPerm: "plan", ...x });
console.assert(same(kindFacts("refactor", ctx({ git: git({ dirty: 3 }) })), [{ text: "3 uncommitted", tone: "warn" }]), "dirty tree");
console.assert(same(kindFacts("refactor", ctx()), [{ text: "working tree clean" }]), "clean tree");
console.assert(same(kindFacts("refactor", ctx({ git: null })), []), "git unknown: nothing");
