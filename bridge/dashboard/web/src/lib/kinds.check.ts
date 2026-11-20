// Run: node bridge/dashboard/web/src/lib/kinds.check.ts
import { KINDS, KIND_ORDER, guessKind, kindFacts, lastCheckOf, nextKind, presetFor, sendPlan, shownKind } from "./kinds.ts";
import type { FactsCtx, LastCheck } from "./kinds.ts";
import type { GitStatus } from "../api.ts";
import type { Turn } from "../chat.ts";
import { hhmm } from "./surfaces.ts";

console.assert(KIND_ORDER.join() === "design,build,refactor,fix,ship,ask", "tab order");

// --- guessKind: the user's real prompts ------------------------------------
const guesses: [string, string | null][] = [
  ["merge this into master locally then clean up", "ship"],
  ["push to main, also make sure the people tab uses those avatars", "ship"],
  ["create pr to v1 dashboard", "ship"],
  // Went out as /design-first: "layout" inside the branch name, "ui" beside a merge.
  ["add these changes into dashboard-layout branch, thenc lean up", "ship"],
  ["we want to gether ui changes except new videos and guide branches into one ui branch then clean up", "ship"],
  ["move changes into main and clean up", "ship"],
  ["the session list jumps when a turn ends", "fix"],
  ["fix suggested word when side with another word", "fix"],
  ["why does the build fail on CI?", "fix"],
  ["reimagine prompt boxes so each kind of work gets its own", "design"],
  ["better ui for the plugins tab", "design"],
  ["the sidebar for mail in contact have bad ui", "design"],
  ["porpmt box have issues, when title is long, pr compoennt will be out of layout, lets redesign it", "design"],
  ["add avatar with its border to inbox header as well", "build"],
  ["what is not pushed on my local branches?", "ask"],
  ["give me local status on branches and what is not pushed", "ask"],
  ["go with 1", null], ["continue", null], ["Yes", null], ["", null],
  ["/design-first a thing", null], ["/goal ship it", null],
];
const START = { start: true, design: true }, MID = { start: false, design: true };
for (const [t, k] of guesses) console.assert(guessKind(t, START) === k, `guessKind(${JSON.stringify(t)}) = ${k}, got ${guessKind(t, START)}`);
// Real first prompts that only mention a UI word (bug reports, questions, build and ship asks) and went out as DESIGN.
for (const t of ["shadow of propmt box in middle earth theme is bad", "remove design tab and add it to per project setting",
  "so explain the lifecycle of design, how we can enable it for a client", "do we have ui for disabling student app? based on video 7",
  "lets commit all changes, create a new realese for nr design with some update notes (so short)",
  "take screenshots and make sure everything works good, layout are following good ux"])
  console.assert(guessKind(t, START) !== "design", `${JSON.stringify(t)} is not design work`);
// Rule order, and Design/Fix only at a session's start.
const more: [string, typeof START, string | null][] = [
  ["i mean UI", MID, null], ["i mean UI", START, null],
  ["better ui for the plugins tab", MID, null],
  ["the session list jumps when a turn ends", MID, null],
  ["merge this into master locally then clean up", MID, "ship"], ["merge this into master locally then clean up", START, "ship"],
  ["did we fix project layout?", START, "ask"], ["is the ui done?", START, "ask"],
  ["do the changes i told exepct generating image", START, null],
  ["can you upload latest preview build into rivendell as new release", START, null],
  ["why does the build fail on CI?", START, "fix"], ["why does the build fail on CI?", MID, "ask"],
  ["reimagine prompt boxes so each kind of work gets its own", { start: true, design: false }, null],
  ["add avatar with its border to inbox header as well", MID, "build"],
];
for (const [t, c, k] of more) console.assert(guessKind(t, c) === k, `guessKind(${JSON.stringify(t)}, ${JSON.stringify(c)}) = ${k}, got ${guessKind(t, c)}`);

// --- shownKind ---------------------------------------------------------------
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
console.assert(same(shownKind("plain", "fix the x", START), { kind: null, how: "plain" }), "plain wins over a guess");
console.assert(same(shownKind("ask", "fix the x", START), { kind: "ask", how: "picked" }), "a pick wins over a guess");
console.assert(same(shownKind(null, "fix the x", START), { kind: "fix", how: "auto" }), "guessing");
console.assert(same(shownKind(null, "fix the x", MID), { kind: null, how: "none" }), "no fix guess mid-thread");
console.assert(same(shownKind("fix", "the x", MID), { kind: "fix", how: "picked" }), "a pick works mid-thread");
console.assert(same(shownKind(null, "ok", START), { kind: null, how: "none" }), "nothing to guess");

// --- nextKind ----------------------------------------------------------------
console.assert(nextKind("ask", 1) === null, "ask wraps to plain");
console.assert(nextKind(null, 1) === "design", "plain wraps to design");
console.assert(nextKind("design", -1) === null, "design back to plain");
console.assert(nextKind(null, -1) === "ask", "plain back to ask");
// Flows switched off in the FLOWS sheet leave Tab's cycle, and are never guessed.
console.assert(nextKind("design", 1, ["build", "refactor"]) === "fix", "an off flow is skipped");
console.assert(nextKind(null, -1, ["ask", "ship"]) === "fix", "back past two off flows");
console.assert(nextKind("build", 1, ["build"]) === "refactor", "a lit flow switched off still moves on");
console.assert(guessKind("merge this into master locally then clean up", { ...START, off: ["ship"] }) !== "ship", "SHIP off: not guessed");
console.assert(guessKind("add avatar with its border to inbox header as well", { ...START, off: ["build"] }) === null, "BUILD off: nothing");
console.assert(guessKind("why does the build fail on CI?", { ...START, off: ["fix"] }) === "ask", "FIX off: the next rule fits");
console.assert(nextKind("build", 1) === "refactor", "forward");

// --- presetFor ---------------------------------------------------------------
console.assert(same(presetFor("design"), { model: "claude-opus-5-5", perm: "", effort: "high", ponytail: "", style: "" }), "design default");
console.assert(same(presetFor("build"), { model: "claude-opus-5-5", perm: "bypassPermissions", effort: "max", ponytail: "", style: "" }), "build default");
console.assert(same(presetFor("ask"), { model: "claude-sonnet-5-5", perm: "", effort: "medium", ponytail: "", style: "" }), "ask default");
console.assert(presetFor("fix", { fix: { effort: "high" } }).effort === "high", "saved beats default");
console.assert(presetFor("fix", { fix: { effort: "high" } }, { effort: "low" }).effort === "low", "session beats saved");
console.assert(presetFor("fix", { ship: { effort: "low" } }).effort === "max", "another kind's save is ignored");
// A Bypass session never gets a kind's mode that asks: today's EFAS "?" prompts went out in plan,
// and each turn raised a plan-approval card plus an Allow/Deny card per Bash call (perm "" = the session's mode).
for (const [t, c] of [["can you check sentry for finding a real case?", MID], ["cant we fix it using logs from sentry?", MID],
  ["wait until he send files, how we can continue to resolve tasks?", START], ["better ui for the plugins tab", START]] as const) {
  const kind = guessKind(t, c)!;
  const perm = sendPlan({ kind, how: "auto", text: t, running: null, flows: true, answering: false, agent: false, run: presetFor(kind) }).run!.perm;
  console.assert(perm === "" || perm === "bypassPermissions", `${kind} (${JSON.stringify(t)}) runs a bypass session in ${perm}`);
}

// --- sendPlan: the flow and who picked it go to the bridge, the text never changes -------
const run = presetFor("build");
const o = { text: "do it", how: "picked" as const, running: null, flows: true, answering: false, agent: false, run };
for (const k of KIND_ORDER) {
  const p = sendPlan({ ...o, kind: k });
  console.assert(p.text === "do it" && p.flow === k && p.by === "you" && p.run === run, `${k} tapped at the start`);
}
const g = sendPlan({ ...o, kind: "fix", how: "auto" });
console.assert(g.flow === "fix" && g.by === "guess", "a guess with no flow running starts it");
const mid = sendPlan({ ...o, kind: "fix", how: "auto", running: "build" });
console.assert(mid.flow === undefined && mid.by === undefined && mid.run === run, "a guess mid-flow only sets the run");
console.assert(sendPlan({ ...o, kind: "fix", running: "build" }).flow === "fix", "a tap mid-flow starts the tapped flow");
console.assert(sendPlan({ ...o, kind: "build", running: "build" }).flow === "build", "a tap on the running flow sends it (the bridge keeps it)");
for (const x of [{ answering: true }, { agent: true }, { kind: null }, { text: "/compact do it" }]) {
  const p = sendPlan({ ...o, kind: "design", ...x });
  console.assert(p.text === (x.text ?? "do it") && p.run === null && p.flow === undefined, `no flow, no run for ${JSON.stringify(x)}`);
}
const off = sendPlan({ ...o, kind: "build", flows: false });
console.assert(off.flow === undefined && off.run === run, "SKILL PATHS off: the run, no flow");
const esc = shownKind("plain", "add a digest", { start: true, design: true });
console.assert(sendPlan({ ...o, kind: esc.kind, how: esc.how }).flow === undefined, "Esc on a lit flow sends no flow");

// --- lastCheckOf -------------------------------------------------------------
const chk = (ok: boolean, at?: number) => ({ type: "checks" as const, command: "t", ok, code: ok ? 0 : 1, ms: 1, passed: 3, failed: ok ? 0 : 1, skipped: 0, new: [], known: [], log: "", tail: "", at });
const turn = (events: Turn["events"], started?: number) => ({ id: "t", prompt: "", events, started, status: "done", pending: [] }) as unknown as Turn;
const lc = lastCheckOf([turn([chk(false, 10)], 5), turn([chk(true, 20)], 15)]);
console.assert(lc?.ok === true && lc.at === 20, "newest check wins, at from the event");
console.assert(lastCheckOf([turn([chk(true)], 15)])?.at === 15, "falls back to the turn start");
console.assert(lastCheckOf([turn([{ type: "text", text: "hi" } as never])]) === null, "no checks, null");
console.assert(lastCheckOf([]) === null, "no turns, null");

// --- kindFacts ---------------------------------------------------------------
const git = (p: Partial<GitStatus>): GitStatus => ({ is_repo: true, branch: "b", upstream: "origin/x", ahead: 0, behind: 0, dirty: 0, files: [], ...p });
const ctx = (p: Partial<FactsCtx> = {}): FactsCtx => ({ git: git({}), lastCheck: null, designLinked: null, mapBuiltAt: null, askPerm: "plan", ...p });
const text = (k: Parameters<typeof kindFacts>[0], c: FactsCtx) => kindFacts(k, c).map((f) => (f.lead ?? "") + f.text).join(" · ");
console.assert(text("ship", ctx({ git: git({ ahead: 3 }) })) === "3 to push · 0 to pull", "ship push/pull");
const dirty = kindFacts("ship", ctx({ git: git({ dirty: 2, ahead: 1 }) }));
console.assert(same(dirty[0], { text: "2 uncommitted", tone: "warn" }), "ship dirty first");
console.assert(text("ship", ctx({ git: git({ upstream: "", unpublished: 4 }) })) === "4 unpublished", "no upstream");
console.assert(text("ship", ctx()) === "in sync", "in sync");
const bad: LastCheck = { ok: false, line: "1 failed", at: null };
console.assert(kindFacts("fix", ctx({ lastCheck: bad }))[0].tone === "err", "red check is err");
console.assert(text("fix", ctx({ lastCheck: bad })) === "last check 1 failed", "fix copy, no time");
const timed = ctx({ lastCheck: { ...bad, at: 1_700_000_000 } });
console.assert(text("fix", timed) === `last check 1 failed · ${hhmm(1_700_000_000)}`, "fix copy with its time");
console.assert(kindFacts("fix", timed)[0].lead === "last check " && kindFacts("fix", timed)[1].tone === undefined, "only the result is red: the words and the time stay plain");
console.assert(text("fix", ctx()) === "no checks run in this session yet", "fix no checks");
console.assert(same(kindFacts("design", ctx()), []), "design: link not known yet is no fact");
console.assert(text("design", ctx({ designLinked: false })) === "no Claude Design project linked", "design unlinked");
console.assert(text("design", ctx({ designLinked: true })) === "drafts → Claude Design", "design linked");
console.assert(same(kindFacts("ask", ctx()), [{ text: "read-only, changes nothing" }]), "ask, no map");
console.assert(same(kindFacts("ask", ctx({ askPerm: "acceptEdits", mapBuiltAt: Date.now() / 1000 })).map((f) => f.text), ["map built just now"]), "ask: no read-only claim once its mode edits");
console.assert(same(kindFacts("ask", ctx({ askPerm: "acceptEdits" })), []), "ask: editing mode, no map, no facts");
console.assert(text("build", ctx()) === "working tree clean", "build: the steps lead (lib/flowsteps), the tree follows");
console.assert(text("build", ctx({ git: git({ dirty: 2 }) })) === "2 uncommitted", "build: dirty tree");
console.assert(text("build", ctx({ git: null })) === "", "build: git unknown, no tree fact");
console.assert(text("build", ctx({ git: git({ is_repo: false }) })) === "", "build: not a repo, no tree fact");
const mapped = text("ask", ctx({ mapBuiltAt: Date.now() / 1000 - 7300 }));
console.assert(mapped === "read-only, changes nothing · map built 2h ago", `ask with a map: ${mapped}`);
const fresh = text("ask", ctx({ mapBuiltAt: Date.now() / 1000 }));
console.assert(fresh === "read-only, changes nothing · map built just now", `ask with a fresh map: ${fresh}`);
console.assert(KINDS.fix.verb === "Fix", "verbs");
