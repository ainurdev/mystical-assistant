import type { CouncilAccount, CouncilBrief, CouncilFinding, CouncilSeat } from "../api";

/* How the COUNCIL tab reads a run (bridge/council.py brief(); design:
   .mystical/design-drafts/council-tab, A · SCOREBOARD): the rail tile, the
   chart's columns, the two pass rules and the hero's words. `round` is the
   round being read while reviewing, else the last one read; `rounds` holds
   only the rounds that scored. Pure, so council.check.ts can pin it. */

/** A run that is still going: its reviewers are reading, or the session is fixing. */
export const live = (c: Pick<CouncilBrief, "status">) => c.status === "reviewing" || c.status === "fixing";
const f1 = (n: number) => n.toFixed(1);

/** The rail tile: the round while a run is on, the score once it passed or stopped. */
export function railTile(c: CouncilBrief | null): { badge?: string; tone?: "ok" | "ask" | "acc"; busy: boolean } {
  if (c && live(c)) return { badge: `R${c.round}`, tone: "acc", busy: true };
  if (c?.status === "passed") return { badge: c.score == null ? undefined : f1(c.score), tone: "ok", busy: false };
  if (c?.status === "stopped") return { badge: c.score == null ? "!" : f1(c.score), tone: "ask", busy: false };
  return { busy: false };
}

/** What the rail tile and its tooltip read off a brief (railTile, hero's pill), plus
 *  the seats. App keeps the brief it holds while this stays put, so a poll that
 *  changes nothing on the rail (a run's `elapsed` ticking) doesn't re-render App. */
export function tileKey(c: CouncilBrief): string {
  return JSON.stringify([c.status, c.round, c.max_rounds, c.score, c.reason, c.rounds.length,
    Object.entries(c.seats).map(([k, s]) => `${k}:${s.state}`)]);
}

/** A column per round the run may use: scored, being read (now), the last of a
 *  passed run (pass) or a stopped one (stall), or with no score (left). Found by
 *  round number: a round stopped before it scored is never kept, and 2 more
 *  rounds go on from the next number, so `rounds` can skip one. */
export function columns(c: CouncilBrief): { n: string; v: number | null; cls: "" | "now" | "pass" | "stall" | "left" }[] {
  const last = c.rounds[c.rounds.length - 1];
  return Array.from({ length: Math.max(c.max_rounds, last?.n ?? 0) }, (_, i) => {
    const r = c.rounds.find((x) => x.n === i + 1);
    return {
      n: `R${i + 1}`,
      v: r?.score ?? null,
      cls: c.status === "reviewing" && i + 1 === c.round ? "now"
        : !r ? "left"
        : r !== last ? ""
        : c.status === "passed" ? "pass" : c.status === "stopped" ? "stall" : "",
    };
  });
}

/** The two pass rules on the last round that scored: the average reaches the
 *  bar, and no must-fix more than half of its reviewers agree on. null before any round has. */
export function rules(c: CouncilBrief): { avg: boolean | null; shared: boolean | null } {
  const last = c.rounds[c.rounds.length - 1];
  if (last?.score == null) return { avg: null, shared: null };
  return { avg: last.score >= c.bar, shared: last.blocking === 0 };
}

/* Reviewers per account (design: .mystical/design-drafts/council-reviewers, B · ROLL
   CALL and B · ON THE BENCH). A reviewer's key is "<agent>:<account>"; its seat
   names it. A run saved before then keys its seats "claude"/"codex" and names none. */

/** An agent's name as the council says it; one not listed keeps its id. */
export const AGENT: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", kimi: "Kimi", opencode: "opencode" };
type Who = { agent: string; label: string };
export const who = (key: string, named?: { agent?: string; label?: string }): Who =>
  ({ agent: named?.agent ?? key.split(":")[0], label: named?.label ?? "" });
const agentName = (w: Who) => AGENT[w.agent] ?? w.agent;
/** "Claude · main"; an agent's own machine login is just "Codex". */
export const reviewerName = (w: Who) => (w.label ? `${agentName(w)} · ${w.label}` : agentName(w));
/** A coin's few letters: the account, else the agent. */
export const coinName = (w: Who) => w.label || agentName(w);
/** Settings' fold head: "Claude main + Codex". */
export const benchNames = (keys: string[], rows: CouncilAccount[] = []) =>
  keys.map((k) => { const w = who(k, rows.find((r) => r.key === k)); return w.label ? `${agentName(w)} ${w.label}` : agentName(w); })
    .join(" + ") || "no reviewers";

/** bridge/council.py blocking(): more than half of those that answered flag it. */
export const agreed = (f: Pick<CouncilFinding, "by">, ran: string[]) => 2 * f.by.filter((k) => ran.includes(k)).length > ran.length;
/** Who answered a round (the last that scored by default): its `ran`, else the seats that finished. */
export function answered(c: CouncilBrief, r = c.rounds[c.rounds.length - 1]): string[] {
  return r?.ran ?? Object.keys(c.seats).filter((k) => c.seats[k].state === "done");
}
/** The roll call's reviewers: an old run's switched-off seat was never one. */
export const reviewers = (c: CouncilBrief) => Object.entries(c.seats).filter(([, s]) => s.state !== "off");
const OLD_OUT: Record<string, string> = { "sign-in": "not signed in", "not-allowed": "not allowed here" };
const satOut = (s: CouncilSeat) => (s.state === "out" ? s.error || "sat out" : OLD_OUT[s.state] ?? null);

/** The line under the roll call: only who sat out or didn't answer, and why; else a count. */
export function rollWhy(c: CouncilBrief): { odd: { name: string; text: string }[]; note: string } {
  const seats = reviewers(c);
  const odd = seats.flatMap(([k, s]) => {
    const out = satOut(s);
    const text = out ? `sat out: ${out}` : s.state === "error" ? `didn't answer: ${(s.error || "error").split("\n")[0]}` : "";
    return text ? [{ name: reviewerName(who(k, s)), text }] : [];
  });
  const n = seats.length;
  const note = odd.length ? ""
    : n === 0 ? "No reviewer is on · add one in Settings ▸ Council"
    : n === 1 ? "1 reviewer · add more in Settings ▸ Council"
    : seats.some(([, s]) => s.state === "running") ? `${n} reviewers reading`
    : seats.every(([, s]) => s.state === "done") ? `${n} reviewers · all answered`
    : `${n} reviewers ready`;
  return { odd, note };
}

/** One coin: its look, and what sits under its mark (a score, a spinner, ! or –). */
export function coin(s: CouncilSeat, passed: boolean): { cls: "" | "busy" | "ok" | "err" | "off"; mid: string } {
  if (s.state === "running") return { cls: "busy", mid: "spin" };
  if (s.state === "done" && s.score != null) return { cls: passed ? "ok" : "", mid: s.score.toFixed(1) };
  if (s.state === "error") return { cls: "err", mid: "!" };
  return { cls: satOut(s) ? "off" : "", mid: "–" };
}

/** The hero's pill and its two lines, in the mockups' words. */
export function hero(c: CouncilBrief): { pill: string; tone: "dim" | "acc" | "ok" | "ask"; l1: string; l2: string } {
  const bar = f1(c.bar);
  const scored = c.rounds.filter((r) => r.score != null) as { n: number; score: number }[];
  if (live(c)) {
    const gap = c.score == null ? 0 : c.bar - c.score;
    return {
      pill: `ROUND ${c.round} OF ${c.max_rounds}`, tone: "acc",
      l1: c.status === "fixing" ? "Fixing the findings" : c.round > 1 ? "Reviewing the fixes" : "Reviewing the work",
      l2: `needs ${bar}${gap > 0 ? ` · ${f1(gap)} to go` : ""}`,
    };
  }
  if (c.status === "passed") {
    const n = c.rounds.length;
    return {
      pill: `PASSED IN ${n} ROUND${n === 1 ? "" : "S"}`, tone: "ok", l1: "Ready for origin",
      l2: `${scored.map((r) => f1(r.score)).join(" → ")} · ${Math.max(1, Math.round(c.elapsed / 60))} min`,
    };
  }
  if (c.status === "stopped") {
    const best = scored.reduce<{ n: number; score: number } | null>((b, r) => (b && b.score >= r.score ? b : r), null);
    // council.py's stall reason, in the mockup's shorter words (the line holds ~22 characters)
    const why = c.reason.replace(/^round (\d+) didn't raise the score$/, "no gain in round $1");
    return {
      pill: "STOPPED · NEEDS YOU", tone: "ask",
      l1: why ? why[0].toUpperCase() + why.slice(1) : "Stopped",
      l2: best ? `best ${f1(best.score)} in round ${best.n} · bar ${bar}` : `bar ${bar}`,
    };
  }
  return { pill: "NOT REVIEWED", tone: "dim", l1: "Ready when you are", l2: `bar ${bar} · ${c.max_rounds} rounds` };
}

/** The three prompts bridge/council.py writes into the session, so the chat can
 *  stamp them instead of drawing them as yours: a round's fix prompt, a finding
 *  you asked to have fixed, and the advice list. null for anything else. */
export type CouncilPrompt =
  | { round: number; max: number; score: number; bar: number; body: string }
  | { round: number; max: number; fix: true; body: string }
  | { advice: true; body: string };
export function parseCouncilPrompt(text: string): CouncilPrompt | null {
  let m = /^\[council (\d+)\/(\d+)\] ([\d.]+) of ([\d.]+)\n([\s\S]+)/.exec(text);
  if (m) return { round: +m[1], max: +m[2], score: +m[3], bar: +m[4], body: m[5] };
  m = /^\[council (\d+)\/(\d+)\] the user wants this fixed\n([\s\S]+)/.exec(text);
  if (m) return { round: +m[1], max: +m[2], fix: true, body: m[3] };
  m = /^\[council advice\]\n([\s\S]+)/.exec(text);
  return m ? { advice: true, body: m[1] } : null;
}

/** A council prompt's findings by severity, from its numbered lines (council.py
 *  _line, "1. MUST · git.py:584 · claude · …"): "1 must · 3 should". A round's
 *  folded stamp says this rather than its fix prompt's opening sentence, which
 *  is the same every round. "" when no line reads as a finding. */
export function sevCount(body: string): string {
  return (["MUST", "SHOULD", "NIT"] as const)
    .map((s) => [s, (body.match(new RegExp(`^\\d+\\. ${s} · `, "gm")) ?? []).length] as const)
    .filter(([, n]) => n).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(" · ");
}
