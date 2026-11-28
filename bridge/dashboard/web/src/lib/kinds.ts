/** The six kinds of work the prompt box guesses (DESIGN, BUILD, REFACTOR, FIX, SHIP, ASK), as data and rules.
 *
 *  Why the rules are local: the guess runs on every keystroke, so it has to be instant and free.
 *  A model call or a POST per keystroke would lag, cost, and send half-typed text off the machine.
 *  Plain regexes on the first words cover the user's real prompts; a wrong guess costs one tap
 *  (pick another kind, or Esc for plain), so a smarter router would buy little.
 *  Measured 2026-11-10 on 28 hand-labelled real first prompts, design or not: a CLI one-shot took
 *  3.5-5 s and scored 19/28 on Haiku, 4.6-7 s and 21/28 on Sonnet (both read "bad ui" as a fix or
 *  a build); these rules scored 25/28, though they were tuned on the same prompts.
 *
 *  Why a typed "/" is never guessed over: the user already named the command. Wrapping it in
 *  /design-first or a diagnosing-bugs prefix would send something they did not write.
 *
 *  Why an answer to a docked question and an agent session get no kind: an answer is a reply to
 *  a card, not new work, and an agent session runs its own harness, so a Claude preset or
 *  slash prefix means nothing there. sendPlan returns the text untouched and no run override.
 *
 *  Pure: no React, no fetch. The UI owns state (the pick) and joins the facts with " · ". */
import type { GitStatus } from "../api.ts";
import type { Turn } from "../chat.ts";
import { checksLine } from "./receipt.ts";
import { ago, hhmm } from "./surfaces.ts";

export type KindId = "design" | "build" | "refactor" | "fix" | "ship" | "ask";
export const KIND_ORDER: KindId[] = ["design", "build", "refactor", "fix", "ship", "ask"];

/** style "" = the session's own Output style, as perm "" is its own mode. */
export interface KindRun { model: string; perm: string; effort: string; ponytail: string; style: string }
export interface Kind { id: KindId; name: string; verb: string; starter: string; preset: KindRun }

const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5";
const k = (id: KindId, name: string, verb: string, starter: string, model: string, perm: string, effort: string): Kind =>
  ({ id, name, verb, starter, preset: { model, perm, effort, ponytail: "", style: "" } });

// perm "" = the session's own mode. A guess must never make a Bypass session ask: plan raised a
// plan card plus an Allow/Deny card per Bash call even after approval; acceptEdits asks per Bash call.
export const KINDS: Record<KindId, Kind> = {
  design: k("design", "DESIGN", "Design", "screens · states · what must not change", OPUS, "", "high"),
  build: k("build", "BUILD", "Build", "what · why · done when", OPUS, "bypassPermissions", "max"),
  refactor: k("refactor", "REFACTOR", "Refactor", "what's tangled · what must not change", OPUS, "bypassPermissions", "max"),
  fix: k("fix", "FIX", "Fix", "expected · got · where — paste a screenshot", OPUS, "bypassPermissions", "max"),
  ship: k("ship", "SHIP", "Ship", "merge this branch, then clean up", OPUS, "bypassPermissions", "high"),
  ask: k("ask", "ASK", "Ask", "ask about the code, a branch, a decision…", SONNET, "", "medium"),
};

/** null = guessing; "plain" = the user dropped the kind. */
export type KindPick = KindId | "plain" | null;

/** `start`: the session has had no turn yet. DESIGN, REFACTOR and FIX are guessed only there: mid-thread
 *  "the list jumps" or "i mean UI" is a follow-up, and a guessed /design-first or diagnosing
 *  prefix would hijack it (a tap or Tab still picks them). `design`: Claude Design is installed. */
export interface GuessCtx { start: boolean; design: boolean;
  /** Flows switched off in the FLOWS sheet: never guessed. */ off?: readonly string[];
  /** GUESS BY HAND: the box guesses nothing; only a tap or Tab lights a flow. */ hand?: boolean }

// First match wins, so order is priority: "merge the broken fix" is shipping, "why does it fail?" is a fix,
// and a trailing "?" is a question even about the ui ("is the ui done?"). The yes/no openers
// (can, do, is...) count only through that "?": without one, "can you upload X" is a request.
// "clean up" and "into … branch" ship anywhere in the prompt: in a month of real prompts every one merged, then cleaned up.
const SHIP = /^(merge|push|commit|rebase|ship|release|deploy|integrate)\b|\b(clean ?up|create (a )?pr|open (a )?pr|merge (this|it|into)|push (it|this|to))\b|\binto\b[^,.?!]{0,30}\bbranch\b/;
// FIX and DESIGN rewrite the prompt, so a word glued into a name by - . / (dashboard-layout, error-boundary.tsx,
// ui/Button) is not intent: \b would split the name and fire on it.
const FIX = /(?<![\w./-])(bug|broken|not working|doesn'?t work|fail(s|ed|ing)?|error|crash\w*|exception|stuck|hang(s|ing)?|freez\w*|slow|lag\w*|wrong|missing|jump(s|ing)?|flicker\w*|regress\w*|can'?t|cannot|isn'?t|won'?t|no longer)(?![\w/-]|\.\w)|^fix /;
// DESIGN wants a design phrase, not a UI word: "theme is bad", "the design tab", "explain design" were bug reports,
// build asks and questions that went out as /design-first. A design prompt it misses costs one tap.
const DESIGN = /(^(design|mock ?up)|(?<![\w./-])(re-?design|reimagine|restyle|mock-?ups?|look and feel)|\b(better|cooler|nicer|proper|bad|weird)( and \w+)? (ui|ux|layout))(?![\w/-]|\.\w)/;
// REFACTOR's words are fixed (flow-gear spec): an opener, or "tangled"/"spaghetti" anywhere, guarded like FIX's.
const REFACTOR = /^(refactor|untangle|restructure|reorgani[sz]e|decouple|dedupe|deduplicate)\b|(?<![\w./-])(tangled|spaghetti)(?![\w/-]|\.\w)/;
const ASK = /\?$|^(what|why|how|where|which|who|when|explain|tell me|show me|give me|list)\b/;
const BUILD = /^(add|make|build|implement|create|support|allow|enable|wire|hook up|change|update|rename|move|remove|delete|replace|improve|extend|write|put|let'?s|lets|we need|i want)\b/;

export function guessKind(text: string, c: GuessCtx): KindId | null {
  const t = text.trim().toLowerCase();
  if (c.hand || t.startsWith("/") || t.split(/\s+/).length < 2) return null;
  const on = (k: KindId) => !c.off?.includes(k);   // an off flow is passed over: the next rule may still fit
  if (on("ship") && SHIP.test(t)) return "ship";
  if (c.start && on("fix") && FIX.test(t)) return "fix";
  if (on("ask") && ASK.test(t)) return "ask";
  if (c.start && on("refactor") && REFACTOR.test(t)) return "refactor";
  if (c.start && c.design && on("design") && DESIGN.test(t)) return "design";
  return on("build") && BUILD.test(t) ? "build" : null;
}

export function shownKind(pick: KindPick, text: string, c: GuessCtx): { kind: KindId | null; how: "auto" | "picked" | "plain" | "none" } {
  if (pick === "plain") return { kind: null, how: "plain" };
  if (pick) return { kind: pick, how: "picked" };
  const kind = guessKind(text, c);
  return { kind, how: kind ? "auto" : "none" };
}

/** Tab order: design … ask, then plain (null), then round again; flows switched off are skipped. */
export function nextKind(from: KindId | null, dir: 1 | -1, off: readonly string[] = []): KindId | null {
  const ring: (KindId | null)[] = [null, ...KIND_ORDER.filter((k) => k === from || !off.includes(k))];
  return ring[(ring.indexOf(from) + dir + ring.length) % ring.length];
}

/** Default, then what the browser saved for the kind, then this session's own edits. */
export function presetFor(kind: KindId, saved?: Partial<Record<KindId, Partial<KindRun>>>, session?: Partial<KindRun>): KindRun {
  return { ...KINDS[kind].preset, ...saved?.[kind], ...session };
}

/** What a send carries. The bridge starts the flow and puts its first step's command in front
 *  (bridge/paths.py start_flow), so the text goes as typed. A flow goes only when the prompt starts
 *  one: a tap or Tab (`you`), or a guess (`guess`) while no flow runs. A guess during a running flow
 *  shapes only this prompt's run, and the prompt stays in that flow. `flows`: SKILL PATHS is on.
 *  `bold`: BOLD lit (shown only beside DESIGN), sent only with a DESIGN flow the prompt starts. */
export function sendPlan(o: { kind: KindId | null; how: "auto" | "picked" | "plain" | "none"; text: string; running: string | null;
  flows: boolean; answering: boolean; agent: boolean; run: KindRun | null; bold?: boolean }):
  { text: string; run: KindRun | null; flow?: KindId; by?: "you" | "guess"; bold?: true } {
  if (!o.kind || o.answering || o.agent || o.text.startsWith("/")) return { text: o.text, run: null };
  const by = o.how === "picked" ? "you" : o.running ? null : "guess";
  if (!o.flows || !by) return { text: o.text, run: o.run };
  return { text: o.text, run: o.run, flow: o.kind, by, ...(o.bold && o.kind === "design" ? { bold: true as const } : {}) };
}

/** BOLD shows beside a lit DESIGN while the kinds are live and the DESIGN PACK gate is open. */
export const boldShows = (kind: KindId | null, kindsOn: boolean, pack: boolean) => kind === "design" && kindsOn && pack;

export interface LastCheck { ok: boolean; line: string; at: number | null }

/** The newest checks event across the turns (oldest first), stamped by the event, else its turn. */
export function lastCheckOf(turns: Turn[]): LastCheck | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const evs = turns[i].events;
    for (let j = evs.length - 1; j >= 0; j--) {
      const e = evs[j];
      if (e.type === "checks") return { ok: e.ok, line: checksLine(e), at: e.at ?? turns[i].started ?? null };
    }
  }
  return null;
}

export interface FactsCtx { git: GitStatus | null; lastCheck: LastCheck | null; mapBuiltAt: number | null;
  /** The perm ASK will run with: it is read-only only in plan. */ askPerm: string }
/** `lead`: plain words before the text, so a state colour lands on the state alone ("last check" stays plain). */
export type Fact = { text: string; tone?: "ok" | "warn" | "err"; lead?: string };

const uncommitted = (g: GitStatus | null): Fact | null => g?.dirty ? { text: `${g.dirty} uncommitted`, tone: "warn" } : null;
const tree = (g: GitStatus | null): Fact[] => g?.is_repo ? [uncommitted(g) ?? { text: "working tree clean" }] : [];

export function kindFacts(kind: KindId, c: FactsCtx): Fact[] {
  const g = c.git;
  switch (kind) {
    case "design":
      return [];
    case "build":
      return tree(g);   // the steps lead the facts (lib/flowsteps)
    case "refactor":
      return tree(g);
    case "fix":
      return c.lastCheck
        ? [{ lead: "last check ", text: c.lastCheck.line, tone: c.lastCheck.ok ? undefined : "err" }, ...(c.lastCheck.at ? [{ text: hhmm(c.lastCheck.at) }] : [])]
        : [{ text: "no checks run in this session yet" }];
    case "ship": {
      const out: Fact[] = [];
      const dirty = uncommitted(g);
      if (dirty) out.push(dirty);
      if (g?.upstream && (g.ahead || g.behind)) out.push({ text: `${g.ahead} to push` }, { text: `${g.behind} to pull` });
      else if (g?.unpublished) out.push({ text: `${g.unpublished} unpublished` });
      if (g && !(g.ahead || g.behind || g.unpublished)) out.push({ text: "in sync" });
      return out;
    }
    case "ask":
      return [...(c.askPerm === "plan" ? [{ text: "read-only, changes nothing" }] : []), ...(c.mapBuiltAt ? [{ text: `map built ${ago(c.mapBuiltAt) === "now" ? "just now" : `${ago(c.mapBuiltAt)} ago`}` }] : [])];
  }
}
