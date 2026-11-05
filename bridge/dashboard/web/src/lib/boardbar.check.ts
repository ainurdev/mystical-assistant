// Run: node bridge/dashboard/web/src/lib/boardbar.check.ts
import { boardLanes } from "./boardbar.ts";

const g = { needs: [1], running: [1, 2], done: Array(18).fill(0), mine: [1, 2, 3], team: [1, 2], later: [1, 2] };
const l = boardLanes(g);
console.assert(l.map((x) => x.n).join() === "7,2,1,18", "counts per lane");
console.assert(l.map((x) => x.flex).join() === "7,5,5,18", "small lanes keep a floor");
console.assert(boardLanes({ needs: [], running: [], done: [], mine: [], team: [], later: [] }).every((x) => x.n === 0 && x.flex === 5), "empty");
console.log("boardbar ok");
