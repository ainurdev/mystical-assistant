// Run: node --experimental-strip-types src/lib/meter.check.ts  (from web/)
//
// The SESSION tab's drawing: the clock folds long waits, the strip's slivers
// merge for the eye only, the window steps, the bands follow the path's steps.
import { BREAK, bands, calm, clock, flowOfRows, flowSpans, helperGroups, kindRows, mixLine, stepLine, stepStarts, stepStats, timeOf, toNow, trackSegs, trackWidths, treemap } from "./meter.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

// 100 s of work, a 13 h wait on you, 100 s of work: the wait takes BREAK px.
const segs: [number, number, "claude" | "tools" | "helpers" | "you" | "away"][] =
  [[0, 100, "claude"], [100, 100 + 13 * 3600, "you"], [100 + 13 * 3600, 200 + 13 * 3600, "tools"]];
const c = clock(segs, 220);
ok(c.end === 220, "the clock fills the width");
ok(c.marks[1].fold && c.marks[1].x1 - c.marks[1].x0 === BREAK, "a 13h wait on you folds to a break");
ok(Math.abs(c.at(50) - 50) < 1e-9 && Math.abs(c.at(150 + 13 * 3600) - 170) < 1e-9, "the rest runs linear around it");
ok(clock([[0, 600, "you"]], 100).marks[0].fold === false, "a 10 minute wait stays on the clock");

const slivers = calm([{ a: 0, b: 1, x0: 0, x1: 10, who: "claude", fold: false },
  { a: 1, b: 1.01, x0: 10, x1: 10.2, who: "tools", fold: false }, { a: 1.01, b: 2, x0: 10.2, x1: 20, who: "you", fold: false }]);
ok(slivers.length === 2 && slivers[0].x1 === 10.2, "a slice under a pixel joins the one before");

ok(stepLine([[0, 100], [10, 200]], (t) => t, (v) => v / 10, 30) === "M0.0,10.0H10.0V20.0H30.0", "the window steps, then runs to the end");

const stations = [{ key: "grill", label: "grill", skill: "grill-with-docs", state: "done" },
  { key: "build-here", label: "build here", skill: "implement", state: "now" },
  { key: "retro", label: "retro", skill: "retro", state: "auto" }];
const turns = [{ prompt: "warm up", started: 10 }, { prompt: "/mattpocock-skills:grill-with-docs make it", started: 100 },
  { prompt: "and wider", started: 200 }, { prompt: "/compact Keep it", started: 300 },
  { prompt: "/mattpocock-skills:implement Work in x", started: 310 }];
const b = bands(turns, [], { stations, at: 120 });
ok(b.map((x) => x.label || x.tone).join(" ") === "GRILL compact BUILD HERE", "steps from the path's turn on; a /compact is a sliver");
ok(b[0].from === 100 && b[0].to === 300 && b[2].to === null && b[0].tone === "done" && b[2].tone === "now", "bands meet; the last runs on");
ok(bands([{ prompt: "hi", started: 5 }], [{ n: 1, started: 5 }, { n: 2, started: 50 }], null).map((x) => `${x.label}:${x.to}`).join(" ") === "#1:50 #2:null",
  "no path: a band per row");

const rows = kindRows({ claude: 76, startup: 66, commands: 42, files: 33, skills: 7, mcp: 1, other: 2 });
ok(rows.length === 6 && rows[5].kind === "other" && rows[5].tokens === 3 && rows[5].folded.join() === "other,mcp", "past five kinds, the rest fold into other");
ok(kindRows({ claude: 5, files: 1 }).length === 2, "few kinds are all listed");
const big = kindRows({ other: 90, claude: 76, startup: 66, commands: 42, files: 33, skills: 7 });
ok(big.filter((r) => r.kind === "other").length === 1 && big.at(-1)!.kind === "other" && big.at(-1)!.tokens === 90 && big.length === 6,
  "a big 'other' of the meter's own still sits last, once, with the rest folded in");

ok(timeOf(segs).you === 13 * 3600 && timeOf(segs).tools === 100, "time sums the strip");
ok(toNow(segs, 99999 + 13 * 3600, true).at(-1)![1] === 99999 + 13 * 3600, "a live strip runs to now");
ok(toNow(segs, 99999 + 13 * 3600, false) === segs, "a finished one doesn't");

// FLOW's numbers per step: worked seconds inside its bands, the spend of the turns
// that started in them, and the first of those turns; a step back after a /compact adds up.
const sb = [{ from: 100, to: 300, label: "GRILL", tone: "done" as const }, { from: 300, to: 310, label: "", tone: "compact" as const },
  { from: 310, to: 400, label: "BUILD HERE", tone: "now" as const }, { from: 400, to: null, label: "GRILL", tone: "now" as const }];
const st = stepStats(sb, [[100, 150, "claude"], [150, 250, "you"], [250, 320, "tools"], [320, 500, "helpers"]],
  [{ id: "a", started: 100 }, { id: "b", started: 200 }, { id: "c", started: 300 }, { id: "d", started: 310 }, { id: "e", started: 450 }],
  { a: { spent: 10 }, b: { spent: 5 }, c: { spent: 99 }, d: { spent: 7 }, e: { spent: 1 } });
ok(st.get("GRILL")!.secs === 50 + 50 + 100 && st.get("GRILL")!.tokens === 16 && st.get("GRILL")!.turn === "a",
  "a step sums worked time and spend over all its bands, waits left out");
ok(st.get("BUILD HERE")!.secs === 10 + 80 && st.get("BUILD HERE")!.tokens === 7 && st.get("BUILD HERE")!.turn === "d", "its first turn is the jump");
ok(!st.has(""), "a /compact sliver is no step");

ok(clock(segs, 220, 6).marks[1].x1 - clock(segs, 220, 6).marks[1].x0 === 6, "the slim curve folds a long wait narrower");

// FLOWS: a turn runs under the latest flow begun by its end (Claude's SetPath mid-turn
// owns that turn), unless that flow had ended before it began; then each flow's span,
// worked seconds and spend.
const fl = [{ at: 100, end: 500 }, { at: 1000, end: null }];
const fr = [{ started: 50, ended: 90, ids: ["z"] }, { started: 95, ended: 200, ids: ["a"] }, { started: 300, ended: 400, ids: ["b", "b2"] },
  { started: 600, ended: 700, ids: ["c"] }, { started: 990, ended: null, ids: ["d"] }];
ok(flowOfRows(fl, fr, 1200).join() === "-1,0,0,-1,1", "a turn before any flow, or after one ended, is outside them");
const sp = flowSpans(fl, fr, [[95, 200, "claude"], [200, 300, "away"], [300, 400, "tools"], [400, 600, "you"], [600, 700, "claude"],
  [700, 990, "away"], [990, 1200, "helpers"]], { z: { spent: 1 }, a: { spent: 10 }, b: { spent: 20 }, b2: { spent: 5 }, c: { spent: 100 }, d: { spent: 7 } }, 1200);
ok(sp[0].rows.join() === "1,2" && sp[0].from === 95 && sp[0].to === 600 && sp[0].secs === 205 && sp[0].tokens === 35,
  "a flow runs from its first turn to the next turn's start: worked time inside, waits and the turns outside it left out");
ok(sp[1].to === 1200 && sp[1].secs === 210 && sp[1].tokens === 7, "the running flow runs to now");
ok(flowSpans([{ at: 5000, end: null }], fr, [], {}, 1200)[0].rows.length === 0, "a flow with no turn yet spans nothing");

// The track: a segment per flow, oldest first; ASK, SHIP and one skill fold where their latest run is.
const tf = [{ path: "design-here", at: 11 }, { path: "ask", at: 12 }, { path: "ship", at: 13 }, { path: "ask", at: 14 }, { path: "one", skill: "tdd", at: 15 }, { path: "fix", at: 16 }];
const ts = trackSegs(tf, [100, 10, 20, 30, 5, 50].map((secs, i) => ({ rows: [i], from: 0, to: 0, secs, tokens: i })));
ok(ts.map((x) => x.key).join(" ") === "#11 ship ask one:tdd #16" && ts[2].runs.join() === "1,3" && ts[2].secs === 40 && ts[2].tokens === 4,
  "ASK runs fold into one segment at their latest, summed; a flow keeps its key when older ones drop");
ok(trackWidths([0, 0], 100).join() === "48.5,48.5", "nothing timed yet: even widths");
ok(trackWidths([30, 10], 100).join() === "63.75,33.25", "each gets its minimum, the rest by worked time");

// ON WHAT at a glance, and its blocks.
ok(JSON.stringify(mixLine({ startup: 40, claude: 30, files: 20, other: 10 })) ===
  JSON.stringify([{ kind: "startup", pct: 40 }, { kind: "claude", pct: 30 }, { kind: "files", pct: 20 }]), "the top three kinds and their share; other never leads");
ok(JSON.stringify(treemap([60, 30, 10], 100, 50)) ===
  JSON.stringify([{ x: 0, y: 0, w: 60, h: 50 }, { x: 60, y: 0, w: 40, h: 37.5 }, { x: 60, y: 37.5, w: 40, h: 12.5 }]),
  "each block slices off what's left, the cut turning each time");

// The hairlines: a step's start, never a /compact's sliver or the same step carrying on after it.
const band = (from: number, label: string, tone: "done" | "now" | "compact" = "done") => ({ from, to: null, label, tone });
ok(stepStarts([band(100, "GRILL"), band(300, "", "compact"), band(310, "GRILL"), band(400, "BUILD HERE", "now")]).join() === "100,400",
  "a step back after a /compact starts nothing");

// HELPERS opened: by the segment of the flow whose turn started each, newest first; ASK runs share one.
const hg = helperGroups([{ id: "h1", turn: "a", running: false, tokens: 5 }, { id: "h2", turn: "b", running: false, tokens: 1 },
  { id: "h3", turn: "c", running: true, tokens: 1 }, { id: "h4", turn: null, running: false, tokens: 9 }],
  [{ ids: ["a"] }, { ids: ["b"] }, { ids: ["c"] }], [0, 1, 2].map((j) => ({ rows: [j], from: 0, to: 0, secs: 0, tokens: 0 })),
  trackSegs([{ path: "ask", at: 1 }, { path: "build", at: 2 }, { path: "ask", at: 3 }], [0, 1, 2].map((j) => ({ rows: [j], from: 0, to: 0, secs: 0, tokens: 0 }))));
ok(hg.map(([k, hs]) => `${k}:${hs.map((h) => h.id).join("+")}`).join(" ") === "1:h3+h1 0:h2 -1:h4",
  "the ASK runs' helpers share one group, running first; a helper outside every flow comes last");
