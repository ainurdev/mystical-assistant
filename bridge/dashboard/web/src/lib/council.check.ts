// Run: node bridge/dashboard/web/src/lib/council.check.ts
// How the COUNCIL tab reads a run: the rail tile, the chart's columns, the two
// pass rules and the hero's pill (design: council-tab, A · SCOREBOARD).
import type { CouncilBrief, CouncilFinding, CouncilRound, CouncilSeat } from "../api.ts";
import {
  agreed, answered, benchNames, coin, coinName, columns, hero, parseCouncilPrompt, railTile, reviewerName, reviewers, rollWhy,
  rules, sevCount, tileKey, who,
} from "./council.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const rounds = (...s: number[]): CouncilRound[] => s.map((score, i) => ({ n: i + 1, score, blocking: 0 }));
const brief = (over: Partial<CouncilBrief>): CouncilBrief => ({
  status: "idle", reason: "", round: 0, max_rounds: 5, bar: 9, score: null, rounds: [], seats: {},
  stuck: null, to_fix: [], fixed: [], answered: [], advice_sent: false, elapsed: 0, ...over,
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

// --- when App re-renders for the tile ---------------------------------------------
ok(tileKey(running) === tileKey({ ...running, elapsed: 999, fixed: running.to_fix, material: null }),
  "a poll where only the clock, the rows or the material moved keeps App's brief");
ok(tileKey(running) !== tileKey({ ...running, round: 4 }), "a new round re-renders");
ok(tileKey(running) !== tileKey({ ...running, status: "stopped" }), "a new status re-renders");
ok(tileKey({ ...running, seats: { claude: { state: "running", score: null, summary: "", error: "" } } })
  !== tileKey({ ...running, seats: { claude: { state: "done", score: 8, summary: "", error: "" } } }), "a seat that finished re-renders");

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
// A round stopped before it scored is never kept, and 2 more rounds go on from round + 1:
// R1 6.4, Stop in R2, more, R3 8.1. Columns go by round number, not by place in `rounds`.
const gap = [{ n: 1, score: 6.4, blocking: 1 }, { n: 3, score: 8.1, blocking: 1 }];
eq(columns(brief({ status: "reviewing", round: 4, max_rounds: 7, rounds: gap, score: 8.1 })).map((c) => [c.v, c.cls]),
  [[6.4, ""], [null, "left"], [8.1, ""], [null, "now"], [null, "left"], [null, "left"], [null, "left"]],
  "a round that never scored stays empty, and R3's score sits under R3");
eq(columns(brief({ status: "stopped", round: 3, max_rounds: 7, rounds: gap, score: 8.1 })).map((c) => c.cls),
  ["", "left", "stall", "left", "left", "left", "left"], "the stall lands on the last round that scored, by its number");
eq(columns(brief({ status: "stopped", round: 6, max_rounds: 5, rounds: [{ n: 6, score: 8, blocking: 1 }] })).length, 6,
  "a round numbered past max_rounds still gets its column");

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

// --- the prompts the council writes into the chat ----------------------------------
eq(parseCouncilPrompt("[council 2/5] 8.1 of 9.0\nFix the null check in save()."),
  { round: 2, max: 5, score: 8.1, bar: 9, body: "Fix the null check in save()." }, "a round's fix prompt");
eq(parseCouncilPrompt("[council 2/5] the user wants this fixed\n- save() null check"),
  { round: 2, max: 5, fix: true, body: "- save() null check" }, "a finding the user asked to fix");
eq(parseCouncilPrompt("[council advice]\n1. rename x\n2. add a test"),
  { advice: true, body: "1. rename x\n2. add a test" }, "the advice list");
eq(parseCouncilPrompt("fix the council tab"), null, "a plain prompt is none of these");
eq(parseCouncilPrompt("[council 2/5] 8.1 of 9.0"), null, "a header with no body is not one");
eq(sevCount("The council reviewed it. Answer a wrong one as \"<number>. NO: <why>\".\n\n1. MUST · git.py:584 · claude+codex · a · b\n"
  + "2. SHOULD · t.py:2 · claude · c\n3. SHOULD · t.py · codex · d\n4. NIT · x.py:1 · claude · e"),
  "1 must · 2 should · 1 nit", "the stamp's tally counts the numbered findings, not the instructions");
eq(sevCount("1. rename x\n2. add a test"), "", "lines without a severity count nothing");

// --- reviewers per account (design: council-reviewers, B · ROLL CALL) --------------------
const seat = (state: CouncilSeat["state"], over: Partial<CouncilSeat> = {}): CouncilSeat =>
  ({ state, score: null, summary: "", error: "", ...over });
const main = { agent: "claude", label: "main" }, codex = { agent: "codex", label: "" };
eq(who("claude:2", { agent: "claude", label: "work" }), { agent: "claude", label: "work" }, "a reviewer is its agent and account");
eq(who("codex"), { agent: "codex", label: "" }, "a run saved before reviewers per account: its key is the agent");
eq([reviewerName(main), reviewerName(codex)], ["Claude · main", "Codex"], "a full name: an agent's own login is the agent");
eq([coinName(main), coinName(codex)], ["main", "Codex"], "a coin's name: the account, else the agent");
eq(benchNames(["claude:1", "codex:", "kimi:a_1"], [{ key: "claude:1", agent: "claude", label: "main", status: "signed in", ok: true, signin: false }]),
  "Claude main + Codex + Kimi", "the fold head names who is on; one with no row yet still reads as its agent");
eq(benchNames([], []), "no reviewers", "nobody on");

const by = (...k: string[]) => ({ by: k }) as CouncilFinding;
eq([agreed(by("a"), ["a"]), agreed(by("a"), ["a", "b"]), agreed(by("a", "b"), ["a", "b", "c"]), agreed(by("a", "b"), ["a", "b", "c", "d"])],
  [true, false, true, false], "a must-fix is agreed when more than half of those that answered flag it");
eq(answered(brief({ rounds: [{ n: 1, score: 8, blocking: 0, ran: ["claude:1", "codex:"] }] })), ["claude:1", "codex:"],
  "who answered a round: its ran");
eq(answered(brief({ rounds: [{ n: 1, score: 8, blocking: 0 }], seats: { claude: seat("done"), codex: seat("error") } })), ["claude"],
  "a bridge from before ran: the seats that finished");

eq(reviewers(brief({ seats: { claude: seat("on"), codex: seat("off") } })).map(([k]) => k), ["claude"],
  "an old run's switched-off Codex was never a reviewer: no coin");
eq(rollWhy(brief({ status: "reviewing", seats: { "claude:1": seat("running", main),
  "kimi:": seat("out", { agent: "kimi", label: "", error: "out of usage" }), "codex:": seat("error", { ...codex, error: "timed out\nstderr" }) } })),
{ odd: [{ name: "Kimi", text: "sat out: out of usage" }, { name: "Codex", text: "didn't answer: timed out" }], note: "" },
"the line names only who sat out or failed, and why");
eq(rollWhy(brief({ seats: { claude: seat("sign-in"), codex: seat("not-allowed") } })).odd.map((o) => o.text),
  ["sat out: not signed in", "sat out: not allowed here"], "an old run's sign-in and not-allowed read as sitting out");
eq(rollWhy(brief({ seats: { "claude:1": seat("on", main) } })).note, "1 reviewer · add more in Settings ▸ Council", "one reviewer");
eq(rollWhy(brief({ seats: { "claude:1": seat("on", main), "codex:": seat("on", codex) } })).note, "2 reviewers ready", "ready");
eq(rollWhy(brief({ status: "reviewing", seats: { "claude:1": seat("running", main), "codex:": seat("done", codex) } })).note,
  "2 reviewers reading", "a round being read");
eq(rollWhy(brief({ status: "passed", seats: { "claude:1": seat("done", main), "codex:": seat("done", codex) } })).note,
  "2 reviewers · all answered", "a round read");
eq(rollWhy(brief({ seats: {} })).note, "No reviewer is on · add one in Settings ▸ Council", "nobody on");

eq([coin(seat("running"), false), coin(seat("done", { score: 8.44 }), false), coin(seat("done", { score: 9.1 }), true),
  coin(seat("error"), false), coin(seat("out"), false), coin(seat("sign-in"), false), coin(seat("on"), false), coin(seat("stopped"), false)],
[{ cls: "busy", mid: "spin" }, { cls: "", mid: "8.4" }, { cls: "ok", mid: "9.1" }, { cls: "err", mid: "!" },
  { cls: "off", mid: "–" }, { cls: "off", mid: "–" }, { cls: "", mid: "–" }, { cls: "", mid: "–" }], "each coin's look and what it holds");
