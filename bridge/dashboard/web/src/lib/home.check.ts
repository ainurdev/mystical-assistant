// Run: node --experimental-strip-types src/lib/home.check.ts  (from web/)
//
// HOME's spine: newest win first, an away row only where a gap falls between
// two wins, each win phrased with its bold verb; and the light the hour puts in the sky.
import { dur, phrase, skyFor, spine } from "./home.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const W = (ts: number, kind: string, text = "", detail?: string) =>
  ({ ts, kind, text, detail, project: "/p", session: "s", turn: "t", big: false }) as never;

const day = {
  since: 0, now: 100_000, worked: 0, work: [],
  wins: [W(90_000, "merge", "feat/x"), W(80_000, "tests", "3,564"), W(10_000, "commits", "6", "paths: flow state")],
  away: [{ start: 20_000, end: 26_000 }, { start: 85_000, end: 95_000 }],
};
const rows = spine(day);
ok(rows.map((r) => r.kind).join(" ") === "win win away win", "the away row sits between the two wins it falls between");
ok(rows[2].kind === "away" && rows[2].text === "away 1h 40m", "an away row says how long the gap was");
ok(!rows.some((r) => r.kind === "away" && r.text === "away 2h 47m"), "a gap after the newest win prints nothing");
ok(spine({ ...day, wins: [] }).length === 0, "no wins, no rows");

const p = phrase(W(1, "commits", "6", "paths: flow state"));
ok(p.verb === "6 commits" && p.aside === "paths: flow state", "folded commits say how many, then the last subject");
ok(phrase(W(1, "pr", "#112")).verb === "opened PR #112", "a PR says its number in the verb");
ok(phrase(W(1, "tests", "3,564")).aside === "3,564", "a test run's count is the aside");

ok(dur(40 * 60) === "40m" && dur(101 * 60) === "1h 41m" && dur(120 * 60) === "2h", "durations read like the mockups");
ok(skyFor(3) === skyFor(22), "the small hours and late evening share the night sky");
ok(skyFor(6).x < 50 && skyFor(12).y === 0 && skyFor(18).x > 50, "the light rises on the left, stands overhead, sets on the right");
ok(skyFor(12).l1 > skyFor(22).l1, "the day's sky runs brighter than the night's");
