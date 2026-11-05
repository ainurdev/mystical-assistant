// Run: node bridge/dashboard/web/src/lib/boardbar.check.ts
import { boardLanes } from "./boardbar.ts";

const t = (...c: (string | null)[]) => c.map((column) => ({ column }));
let l = boardLanes(t("Doing", "Todo", "Doing", null, "Todo", "Doing"));
console.assert(l.map((x) => x.name).join() === "DOING,TODO,BACKLOG", "first-seen order, null is Backlog");
console.assert(l.map((x) => x.n).join() === "3,2,1", "counts");
console.assert(l.map((x) => x.flex).join() === "5,5,5", "floor");
console.assert(l[0].color === "var(--txl)" && l[1].color === "var(--ok)", "colours by position");
l = boardLanes(t("a", "b", "c", "d", "e", "f", "g", "g"));
console.assert(l.length === 5 && l[4].name === "+3 more" && l[4].n === 4, "fold past 5");
console.assert(boardLanes(t("a", "b", "c", "d", "e")).length === 5 && boardLanes(t("a", "b", "c", "d", "e"))[4].name === "E", "exactly 5 stay");
console.assert(boardLanes([]).length === 0, "empty");
console.log("boardbar ok");
