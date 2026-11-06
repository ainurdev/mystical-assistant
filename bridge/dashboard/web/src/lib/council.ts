import type { CouncilBrief } from "../api";

/* How the COUNCIL tab reads a run (bridge/council.py brief(); design:
   .mystical/design-drafts/council-tab, A · SCOREBOARD): the rail tile, the
   chart's columns, the two pass rules and the hero's words. `round` is the
   round being read while reviewing, else the last one read; `rounds` holds
   only the rounds that scored. Pure, so council.check.ts can pin it. */

const live = (c: CouncilBrief) => c.status === "reviewing" || c.status === "fixing";
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
 *  bar, and no must-fix every seat agrees on. null before any round has. */
export function rules(c: CouncilBrief): { avg: boolean | null; shared: boolean | null } {
  const last = c.rounds[c.rounds.length - 1];
  if (last?.score == null) return { avg: null, shared: null };
  return { avg: last.score >= c.bar, shared: last.blocking === 0 };
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
