// Run: node bridge/dashboard/web/src/lib/turnclock.check.ts
import { turnClock } from "./turnclock.ts";

const at = (h: number, m: number, d = 5) => new Date(2026, 10, d, h, m).getTime() / 1000;
const MIN = 0;   // the visible floor is CSS now

const now = at(17, 25);
const c = turnClock([
  { started: at(14, 54), secs: 103 * 60, asks: 3, running: false },
  { started: at(16, 39), secs: 17 * 60, asks: 0, running: false },
  { started: at(16, 56), secs: 29 * 60, asks: 1, running: true },
], now);
console.assert(c.blocks.length === 3 && c.blocks.map((b) => b.running).join() === "false,false,true", "3 turns: third running");
console.assert(c.blocks.map((b) => b.n).join() === "1,2,3" && c.blocks[0].asks === 3, "3 turns: numbered, asks kept");
console.assert(c.ticks.map((t) => t.label).join() === "15:00,16:00,17:00", `3 turns: hour ticks, got ${c.ticks.map((t) => t.label)}`);
console.assert(c.from === at(14, 54) && c.to === now, "3 turns: from first start to now");
console.assert(c.blocks.every((b) => b.x >= 0 && b.x + b.w <= 1 + 1e-9 && b.w >= MIN), "3 turns: fractions in range");
console.assert(c.blocks[0].x === 0 && c.blocks[0].x < c.blocks[1].x && c.blocks[1].x < c.blocks[2].x, "3 turns: in time order");

const one = turnClock([{ started: now, secs: 0, asks: 0, running: true }], now);
console.assert(one.blocks.length === 1 && one.blocks[0].w >= MIN && one.blocks[0].x + one.blocks[0].w <= 1 + 1e-9, "1 turn: one block, inside the strip");

const many = Array.from({ length: 60 }, (_, i) => ({ started: at(9, 0) + i * 4320, secs: 30, asks: 0, running: false }));
const m = turnClock(many, at(9, 0) + 3 * 86400);
console.assert(m.blocks.length === 60 && m.blocks.every((b) => b.w >= MIN && b.x + b.w <= 1 + 1e-9), "60 turns: all inside the strip");
console.assert(m.ticks.length >= 2 && m.ticks.every((t) => !/:/.test(t.label)), `60 turns: day ticks, got ${m.ticks.map((t) => t.label)}`);

console.assert(turnClock([], now).blocks.length === 0, "none: nothing");
