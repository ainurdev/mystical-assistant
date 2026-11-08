/** The five kinds of work the prompt box guesses (DESIGN, BUILD, FIX, SHIP, ASK), as data and rules.
 *
 *  Why the rules are local: the guess runs on every keystroke, so it has to be instant and free.
 *  A model call or a POST per keystroke would lag, cost, and send half-typed text off the machine.
 *  Plain regexes on the first words cover the user's real prompts; a wrong guess costs one tap
 *  (pick another kind, or Esc for plain), so a smarter router would buy little.
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

export type KindId = "design" | "build" | "fix" | "ship" | "ask";
export const KIND_ORDER: KindId[] = ["design", "build", "fix", "ship", "ask"];

export interface KindRun { model: string; perm: string; effort: string; ponytail: string }
export interface Kind { id: KindId; name: string; verb: string; starter: string; preset: KindRun }

const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5";
const k = (id: KindId, name: string, verb: string, starter: string, model: string, perm: string, effort: string): Kind =>
  ({ id, name, verb, starter, preset: { model, perm, effort, ponytail: "" } });

export const KINDS: Record<KindId, Kind> = {
  design: k("design", "DESIGN", "Design", "screens · states · what must not change", OPUS, "acceptEdits", "high"),
  build: k("build", "BUILD", "Build", "what · why · done when", OPUS, "bypassPermissions", "max"),
  fix: k("fix", "FIX", "Fix", "expected · got · where — paste a screenshot", OPUS, "bypassPermissions", "max"),
  ship: k("ship", "SHIP", "Ship", "merge this branch, then clean up", OPUS, "bypassPermissions", "high"),
  ask: k("ask", "ASK", "Ask", "ask about the code, a branch, a decision…", SONNET, "plan", "medium"),
};

/** null = guessing; "plain" = the user dropped the kind. */
export type KindPick = KindId | "plain" | null;

// First match wins, so order is priority: "merge the broken fix" is shipping, "why does it fail?" is a fix.
const RULES: [KindId, RegExp][] = [
  ["ship", /^(merge|push|commit|rebase|ship|release|deploy|clean ?up|integrate)\b|\b(create (a )?pr|open (a )?pr|merge (this|it|into)|push (it|this|to))\b/],
  ["fix", /\b(bug|broken|not working|doesn'?t work|fail(s|ed|ing)?|error|crash\w*|exception|stuck|hang(s|ing)?|freez\w*|slow|lag\w*|wrong|missing|jump(s|ing)?|flicker\w*|regress\w*|can'?t|cannot|isn'?t|won'?t|no longer)\b|^fix /],
  ["design", /\b(design|redesign|reimagine|mock-?ups?|layout|ui|ux|look and feel|restyle|style|theme|visual\w*)\b/],
  ["ask", /\?$|^(what|why|how|where|which|who|when|is|are|does|do|can|could|should|explain|tell me|show me|give me|list)\b/],
  ["build", /^(add|make|build|implement|create|support|allow|enable|wire|hook up|change|update|rename|move|remove|delete|replace|refactor|improve|extend|write|put|let'?s|lets|we need|i want)\b/],
];

export function guessKind(text: string): KindId | null {
  const t = text.trim().toLowerCase();
  if (t.startsWith("/") || t.split(/\s+/).length < 2) return null;
  return RULES.find(([, re]) => re.test(t))?.[0] ?? null;
}

export function shownKind(pick: KindPick, text: string): { kind: KindId | null; how: "auto" | "picked" | "plain" | "none" } {
  if (pick === "plain") return { kind: null, how: "plain" };
  if (pick) return { kind: pick, how: "picked" };
  const kind = guessKind(text);
  return { kind, how: kind ? "auto" : "none" };
}

/** Tab order: design … ask, then plain (null), then round again. */
export function nextKind(from: KindId | null, dir: 1 | -1): KindId | null {
  const ring: (KindId | null)[] = [null, ...KIND_ORDER];
  return ring[(ring.indexOf(from) + dir + ring.length) % ring.length];
}

/** Default, then what the browser saved for the kind, then this session's own edits. */
export function presetFor(kind: KindId, saved?: Partial<Record<KindId, Partial<KindRun>>>, session?: Partial<KindRun>): KindRun {
  return { ...KINDS[kind].preset, ...saved?.[kind], ...session };
}

export function sendPlan(o: { kind: KindId | null; text: string; pack: boolean; answering: boolean; agent: boolean; run: KindRun | null }):
  { text: string; run: KindRun | null } {
  if (!o.kind || o.answering || o.agent) return { text: o.text, run: null };
  const prefix = o.kind === "design" ? "/design-first " : o.kind === "fix" && o.pack ? "/mattpocock-skills:diagnosing-bugs " : "";
  return { text: prefix + o.text, run: o.run };
}

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

export interface FactsCtx { git: GitStatus | null; lastCheck: LastCheck | null; designLinked: boolean | null; mapBuiltAt: number | null; pack: boolean }
export type Fact = { text: string; tone?: "ok" | "warn" | "err" };

const uncommitted = (g: GitStatus | null): Fact | null => g?.dirty ? { text: `${g.dirty} uncommitted`, tone: "warn" } : null;

export function kindFacts(kind: KindId, c: FactsCtx): Fact[] {
  const g = c.git;
  switch (kind) {
    case "design":
      return [{ text: c.designLinked ? "drafts → Claude Design" : "no Claude Design project linked" }];
    case "build":
      return [{ text: c.pack ? "grill, then build here" : "builds here" }, uncommitted(g) ?? { text: "working tree clean" }];
    case "fix":
      return c.lastCheck
        ? [{ text: `last check ${c.lastCheck.line}${c.lastCheck.at ? ` · ${hhmm(c.lastCheck.at)}` : ""}`, tone: c.lastCheck.ok ? undefined : "err" }]
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
      return [{ text: "read-only, changes nothing" }, ...(c.mapBuiltAt ? [{ text: `map built ${ago(c.mapBuiltAt)} ago` }] : [])];
  }
}
