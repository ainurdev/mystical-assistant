// Run: node --experimental-strip-types src/lib/weekgrid.check.ts  (from web/)
import { weekGrid } from "./weekgrid.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const WEEK = [[2,1,0,0,0,0,0,0,0,0,0,1,1,1,0,1,0,2,2,2,3,0,0,4],[0,0,0,0,0,0,0,0,0,0,0,1,1,0,25,7,8,8,0,3,4,5,6,7],[2,8,19,18,11,0,0,0,0,0,0,9,7,2,0,0,4,3,6,4,0,4,0,0],[5,0,0,0,0,0,0,0,0,0,9,10,6,2,3,2,6,14,6,1,7,0,0,0],[],[],[]];
const thu = new Date(2026, 10, 5, 20, 32);   // Thursday 5 Nov, 20:32

const g = weekGrid(WEEK, thu, 0);
ok(g.cells.length === 7 && g.cells.every((r) => r.length === 24), "7 rows of 24 cells, short rows padded");
ok(JSON.stringify(g.busiest) === JSON.stringify({ day: 1, hour: 14, n: 25 }), "busiest is Tue 14:00 with 25");
ok(g.cells[1][14].shade === 1, "the max cell is shade 1");
ok(g.cells[1][11].shade === (1 / 25) ** 0.6 && g.cells[1][13].shade === 0, "shade is (v/max)^0.6, 0 for none");
ok(g.cells[3][20].now && !g.cells[3][20].future, "Thu 20 is now");
ok(g.cells[3][21].future && !g.cells[3][21].now, "Thu 21 is future");
ok(g.cells[3][19].future === false, "Thu 19 is past");
ok(g.cells[4].every((c) => c.future && c.v === 0), "Fri is all future");
ok(g.cells.flat().filter((c) => c.now).length === 1, "exactly one now cell");

const none = weekGrid(undefined, thu, 0);
ok(none.busiest === null && none.cells.flat().every((c) => c.v === 0 && c.shade === 0), "no hours: all zero, no busiest");

const last = weekGrid(WEEK, thu, 1);
ok(last.cells.flat().every((c) => !c.future && !c.now), "last week: no future or now cells");
ok(last.busiest?.n === 25, "last week still finds its busiest");
