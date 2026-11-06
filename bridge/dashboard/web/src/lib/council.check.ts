// Run: node bridge/dashboard/web/src/lib/council.check.ts
// How the COUNCIL tab reads a run: the rail tile, the chart's columns, the two
// pass rules and the hero's pill (design: council-tab, A · SCOREBOARD).
import type { CouncilBrief, CouncilRound } from "../api.ts";
import { columns, hero, railTile, rules } from "./council.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const rounds = (...s: number[]): CouncilRound[] => s.map((score, i) => ({ n: i + 1, score, blocking: 0 }));
const brief = (over: Partial<CouncilBrief>): CouncilBrief => ({
  status: "idle", reason: "", round: 0, max_rounds: 5, bar: 9, score: null, rounds: [], seats: {},
  findings: [], previous: [], stuck: null, advice: [], fixed_total: 0, advice_sent: false, elapsed: 0, ...over,
});
const idle = brief({});
const running = brief({ status: "reviewing", round: 3, rounds: rounds(6.4, 8.1), score: 8.1 });
const passed = brief({ status: "passed", round: 3, rounds: rounds(6.4, 8.1, 9.3), score: 9.3, elapsed: 18 * 60 });
const stopped = brief({ status: "stopped", round: 5, rounds: rounds(6.4, 7.6, 8.2, 8.4, 8.3), score: 8.3,
  reason: "round 5 didn't raise the score" });

// --- the rail tile --------------------------------------------------------------
eq(railTile(running), { badge: "R3", tone: "acc", busy: true }, "a run in progress: its round, in the accent, orbiting");
eq(railTile(brief({ status: "fixing", round: 2, rounds: rounds(6.4, 8.1) })), { badge: "R2", tone: "acc", busy: true },
  "fixing counts as in progress");
eq(railTile(passed), { badge: "9.3", tone: "ok", busy: false }, "passed: the score, in ok");
eq(railTile(stopped), { badge: "8.3", tone: "ask", busy: false }, "stopped: the score, waiting on you");
eq(railTile(brief({ status: "stopped", round: 1, reason: "you stopped it" })), { badge: "!", tone: "ask", busy: false },
  "stopped before any score: !");
eq(railTile(idle), { busy: false }, "idle: a calm tile");
eq(railTile(null), { busy: false }, "no brief yet: a calm tile");

// --- the chart's columns --------------------------------------------------------
eq(columns(running).map((c) => c.cls), ["", "", "now", "left", "left"], "round 3 of 5 under review");
eq(columns(running).map((c) => c.v), [6.4, 8.1, null, null, null], "scores where a round has run");
eq(columns(running).map((c) => c.n), ["R1", "R2", "R3", "R4", "R5"], "a column per round the run may use");
eq(columns(stopped).map((c) => c.cls), ["", "", "", "", "stall"], "a stopped run's last round stalls");
eq(columns(passed).map((c) => c.cls), ["", "", "pass", "left", "left"], "a passed run's last round passes");
eq(columns(idle).map((c) => c.cls), ["left", "left", "left", "left", "left"], "nothing run yet: every column left");
eq(columns(brief({ status: "fixing", round: 2, rounds: rounds(6.4, 8.1) })).map((c) => c.cls), ["", "", "left", "left", "left"],
  "fixing: no column is being read");
eq(columns(brief({ status: "reviewing", round: 6, max_rounds: 7, rounds: rounds(6, 7, 7.5, 8, 8) })).length, 7,
  "2 more rounds widen the chart");

// --- the pass rules -------------------------------------------------------------
eq(rules(brief({ status: "reviewing", round: 3, score: 8.1, rounds: [{ n: 1, score: 6.4, blocking: 2 }, { n: 2, score: 8.1, blocking: 1 }] })),
  { avg: false, shared: false }, "8.1 with 1 shared must-fix fails both");
eq(rules(passed), { avg: true, shared: true }, "9.3 with none passes both");
eq(rules(brief({ status: "stopped", round: 2, score: 9.2, rounds: [{ n: 1, score: 7, blocking: 1 }, { n: 2, score: 9.2, blocking: 1 }] })),
  { avg: true, shared: false }, "over the bar but blocked");
eq(rules(idle), { avg: null, shared: null }, "before any round: neither rule has an answer");
eq(rules(brief({ status: "reviewing", round: 1 })), { avg: null, shared: null }, "round 1 still reading: no answer yet");

// --- the hero -------------------------------------------------------------------
eq(hero(idle), { pill: "NOT REVIEWED", tone: "dim", l1: "Ready when you are", l2: "bar 9.0 · 5 rounds" }, "idle");
eq(hero(running), { pill: "ROUND 3 OF 5", tone: "acc", l1: "Reviewing the fixes", l2: "needs 9.0 · 0.9 to go" }, "running");
eq(hero(brief({ status: "fixing", round: 2, rounds: rounds(6.4, 8.1), score: 8.1 })).l1, "Fixing the findings", "fixing");
eq(hero(brief({ status: "reviewing", round: 1 })).l2, "needs 9.0", "round 1: no gap to tell yet");
eq(hero(passed), { pill: "PASSED IN 3 ROUNDS", tone: "ok", l1: "Ready for origin", l2: "6.4 → 8.1 → 9.3 · 18 min" }, "passed");
eq(hero(brief({ status: "passed", round: 1, rounds: rounds(9.5), score: 9.5, elapsed: 20 })).pill, "PASSED IN 1 ROUND",
  "one round is singular");
eq(hero(stopped), { pill: "STOPPED · NEEDS YOU", tone: "ask", l1: "No gain in round 5", l2: "best 8.4 in round 4 · bar 9.0" },
  "stopped: the stall in the mockup's words");
eq(hero(brief({ status: "stopped", round: 1, reason: "you stopped it" })), { pill: "STOPPED · NEEDS YOU", tone: "ask",
  l1: "You stopped it", l2: "bar 9.0" }, "stopped before a score: any other reason as it is, and just the bar");
