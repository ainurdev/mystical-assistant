// Run: node bridge/dashboard/web/src/lib/trunk.check.ts
import { trunk, trunkState, type TrunkState } from "./trunk.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mk = (...s: TrunkState[]) => s.map((state, i) => ({ name: `b/${i}`, state }));

const mock = trunk(mk("working", "working", "pr", "local", "clean", "base"));
console.assert(mock.tips.length === 6 && mock.more === 0, "mock: 6 tips");
console.assert(same(mock.tips.map((t) => t.low), [false, true, false, true, false, true]), "mock: alternate high/low");
console.assert(mock.tips[0].x < mock.tips[5].x && mock.tips.every((t) => t.x > 0 && t.x < 1), "mock: left to right inside the trunk");
console.assert(same(mock.legend, [{ state: "working", count: 2 }, { state: "pr", count: 1 }, { state: "clean", count: 1 }, { state: "local", count: 1 }]), "mock: legend counts, base left out");

const one = trunk(mk("base"));
console.assert(one.tips.length === 1 && one.tips[0].x === 0.5 && one.legend.length === 0, "one row: main only, centred");
console.assert(trunk([]).tips.length === 0, "none: no tips");

const many = trunk(mk(...Array<TrunkState>(12).fill("local")));
console.assert(many.tips.length === 8 && many.more === 4, "12 rows: 8 tips and +4");
console.assert(many.legend[0].count === 12, "12 rows: legend counts them all");

const row = (o: object) => ({ base: false, activity: null, pr: null, landed: false, ...o }) as Parameters<typeof trunkState>[0];
console.assert(trunkState(row({ activity: "asking", base: true })) === "waits", "state: a waiting session wins");
console.assert(trunkState(row({ activity: "working" })) === "working", "state: working");
console.assert(trunkState(row({ base: true })) === "base", "state: base");
console.assert(trunkState(row({ pr: { state: "OPEN" } })) === "pr", "state: open PR");
console.assert(trunkState(row({ pr: { state: "MERGED" }, landed: true })) === "clean", "state: merged PR is clean-up");
console.assert(trunkState(row({ landed: true })) === "clean", "state: landed");
console.assert(trunkState(row({})) === "local", "state: local");
console.log("trunk.check ok");
