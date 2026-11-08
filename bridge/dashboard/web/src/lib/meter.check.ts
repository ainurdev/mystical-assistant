// Run: node --experimental-strip-types src/lib/meter.check.ts  (from web/)
//
// The SESSION tab's drawing: the clock folds long waits, the strip's slivers
// merge for the eye only, the window steps, the bands follow the path's steps.
import { BREAK, bands, calm, clock, kindRows, stepLine, timeOf, toNow } from "./meter.ts";

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
