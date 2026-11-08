// Run: node bridge/dashboard/web/src/lib/kinds.check.ts
import { KINDS, KIND_ORDER, guessKind, kindFacts, lastCheckOf, nextKind, presetFor, sendPlan, shownKind } from "./kinds.ts";
import type { FactsCtx, LastCheck } from "./kinds.ts";
import type { GitStatus } from "../api.ts";
import type { Turn } from "../chat.ts";

console.assert(KIND_ORDER.join() === "design,build,fix,ship,ask", "tab order");

// --- guessKind: the user's real prompts ------------------------------------
const guesses: [string, string | null][] = [
  ["merge this into master locally then clean up", "ship"],
  ["push to main, also make sure the people tab uses those avatars", "ship"],
  ["create pr to v1 dashboard", "ship"],
  ["the session list jumps when a turn ends", "fix"],
  ["fix suggested word when side with another word", "fix"],
  ["why does the build fail on CI?", "fix"],
  ["reimagine prompt boxes so each kind of work gets its own", "design"],
  ["better ui for the plugins tab", "design"],
  ["add avatar with its border to inbox header as well", "build"],
  ["what is not pushed on my local branches?", "ask"],
  ["give me local status on branches and what is not pushed", "ask"],
  ["go with 1", null], ["continue", null], ["Yes", null], ["", null],
  ["/design-first a thing", null], ["/goal ship it", null],
];
for (const [t, k] of guesses) console.assert(guessKind(t) === k, `guessKind(${JSON.stringify(t)}) = ${k}, got ${guessKind(t)}`);

// --- shownKind ---------------------------------------------------------------
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
console.assert(same(shownKind("plain", "fix the x"), { kind: null, how: "plain" }), "plain wins over a guess");
console.assert(same(shownKind("ask", "fix the x"), { kind: "ask", how: "picked" }), "a pick wins over a guess");
console.assert(same(shownKind(null, "fix the x"), { kind: "fix", how: "auto" }), "guessing");
console.assert(same(shownKind(null, "ok"), { kind: null, how: "none" }), "nothing to guess");

// --- nextKind ----------------------------------------------------------------
console.assert(nextKind("ask", 1) === null, "ask wraps to plain");
console.assert(nextKind(null, 1) === "design", "plain wraps to design");
console.assert(nextKind("design", -1) === null, "design back to plain");
console.assert(nextKind(null, -1) === "ask", "plain back to ask");
console.assert(nextKind("build", 1) === "fix", "forward");

// --- presetFor ---------------------------------------------------------------
console.assert(same(presetFor("design"), { model: "claude-opus-5-5", perm: "acceptEdits", effort: "high", ponytail: "" }), "design default");
console.assert(same(presetFor("build"), { model: "claude-opus-5-5", perm: "bypassPermissions", effort: "max", ponytail: "" }), "build default");
console.assert(same(presetFor("ask"), { model: "claude-sonnet-5-5", perm: "plan", effort: "medium", ponytail: "" }), "ask default");
console.assert(presetFor("fix", { fix: { effort: "high" } }).effort === "high", "saved beats default");
console.assert(presetFor("fix", { fix: { effort: "high" } }, { effort: "low" }).effort === "low", "session beats saved");
console.assert(presetFor("fix", { ship: { effort: "low" } }).effort === "max", "another kind's save is ignored");

// --- sendPlan ----------------------------------------------------------------
const run = presetFor("build");
const o = { text: "do it", pack: true, answering: false, agent: false, run };
console.assert(sendPlan({ ...o, kind: "design" }).text === "/design-first do it", "design");
console.assert(sendPlan({ ...o, kind: "fix" }).text === "/mattpocock-skills:diagnosing-bugs do it", "fix with pack");
console.assert(sendPlan({ ...o, kind: "fix", pack: false }).text === "do it", "fix without pack");
for (const k of ["build", "ship", "ask"] as const) console.assert(sendPlan({ ...o, kind: k }).text === "do it", `${k} as typed`);
console.assert(sendPlan({ ...o, kind: "build" }).run === run, "run rides along");
for (const x of [{ answering: true }, { agent: true }, { kind: null }]) {
  const p = sendPlan({ ...o, kind: "design", ...x });
  console.assert(p.text === "do it" && p.run === null, `no kind for ${JSON.stringify(x)}`);
}

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
const ctx = (p: Partial<FactsCtx> = {}): FactsCtx => ({ git: git({}), lastCheck: null, designLinked: null, mapBuiltAt: null, pack: false, ...p });
const text = (k: Parameters<typeof kindFacts>[0], c: FactsCtx) => kindFacts(k, c).map((f) => f.text).join(" · ");
console.assert(text("ship", ctx({ git: git({ ahead: 3 }) })) === "3 to push · 0 to pull", "ship push/pull");
const dirty = kindFacts("ship", ctx({ git: git({ dirty: 2, ahead: 1 }) }));
console.assert(same(dirty[0], { text: "2 uncommitted", tone: "warn" }), "ship dirty first");
console.assert(text("ship", ctx({ git: git({ upstream: "", unpublished: 4 }) })) === "4 unpublished", "no upstream");
console.assert(text("ship", ctx()) === "in sync", "in sync");
const bad: LastCheck = { ok: false, line: "1 failed", at: null };
console.assert(kindFacts("fix", ctx({ lastCheck: bad }))[0].tone === "err", "red check is err");
console.assert(text("fix", ctx()) === "no checks run in this session yet", "fix no checks");
console.assert(text("design", ctx({ designLinked: false })) === "no Claude Design project linked", "design unlinked");
console.assert(text("design", ctx({ designLinked: true })) === "drafts → Claude Design", "design linked");
console.assert(same(kindFacts("ask", ctx()), [{ text: "read-only, changes nothing" }]), "ask, no map");
console.assert(text("build", ctx({ pack: true })) === "grill, then build here · working tree clean", "build with pack");
console.assert(text("build", ctx({ git: git({ dirty: 2 }) })) === "builds here · 2 uncommitted", "build without pack");
console.assert(text("build", ctx({ git: null })) === "builds here", "build: git unknown, no tree fact");
console.assert(text("build", ctx({ git: git({ is_repo: false }), pack: true })) === "grill, then build here", "build: not a repo, no tree fact");
const mapped = text("ask", ctx({ mapBuiltAt: Date.now() / 1000 - 7300 }));
console.assert(mapped === "read-only, changes nothing · map built 2h ago", `ask with a map: ${mapped}`);
const fresh = text("ask", ctx({ mapBuiltAt: Date.now() / 1000 }));
console.assert(fresh === "read-only, changes nothing · map built just now", `ask with a fresh map: ${fresh}`);
console.assert(KINDS.fix.verb === "Fix", "verbs");
