// Run: node src/lib/ticketdag.check.ts  (from web/) — grep the output for "Assertion failed".
import { dagLayout, kindOf } from "./ticketdag.ts";

const k = (status: string, state?: string, stalled?: boolean) => kindOf({ status, stalled }, state);
console.assert(k("done") === "done" && k("fix") === "fix" && k("queued") === "q" && k("missing") === "q", "done, fix and waiting rows");
console.assert(k("running") === "run" && k("running", "working") === "run", "a running ticket runs");
console.assert(k("running", undefined, true) === "idle" && k("running", "done", true) === "idle", "a stalled ticket is idle");
console.assert(k("running", "asking") === "ask" && k("running", "awaiting", true) === "ask", "an ask wins over idle");
console.assert(k("fix", "asking", true) === "fix" && k("done", "asking", true) === "done", "fix and done win over the session's state");
console.assert(k("yours") === "you", "a ticket of yours waits for Go, not in the queue");

const T = (n: string, ...blockedBy: string[]) => ({ n, blockedBy });
const g = dagLayout([T("01"), T("02"), T("03"), T("04"), T("05", "04"), T("06", "02", "03")]);
const at = (n: string) => g.nodes.find((x) => x.n === n)!;
const e = (a: string, b: string) => g.edges.some((x) => x.from === a && x.to === b);

console.assert(["01", "02", "03", "04"].every((n) => at(n).col === 0), "01-04 sit in column 0");
console.assert(at("05").col === 1 && at("06").col === 1, "05 and 06 sit in column 1");
console.assert(g.cols === 3, "three columns, MERGE the last");
console.assert(at("MERGE").col === 2, "MERGE is in the last column");
console.assert(["01", "02", "03", "04"].map((n) => at(n).row).join() === "0,1,2,3", "rows go by number");
console.assert(at("06").row === 0 && at("05").row === 1, "a later column goes by its blockers' average row: 06 (rows 1, 2) above 05 (row 3)");
// The Watcher set: 06 waits on 01 (row 0) alone, so it sits above 03, 04 and 05, and 01's edge to it never crosses 02's.
const w = dagLayout([T("01"), T("02"), T("03", "01", "02"), T("04", "02"), T("05", "02"), T("06", "01"), T("07", "03", "04"), T("08", "05", "07"), T("09", "06")]);
const wr = (n: string) => w.nodes.find((x) => x.n === n)!.row;
console.assert(["06", "03", "04", "05"].map(wr).join() === "0,1,2,3", "wave 2 orders 06, 03, 04, 05");
console.assert(wr("09") === 0 && wr("07") === 1, "wave 3 follows: 09 under 06's row, 07 under 03/04");
console.assert(e("04", "05") && e("02", "06") && e("03", "06"), "blocker edges");
console.assert(e("01", "MERGE") && e("05", "MERGE") && e("06", "MERGE"), "tickets nothing waits on feed MERGE");
console.assert(!e("04", "MERGE") && g.edges.length === 6, "no other edges");
const c = dagLayout([T("1"), T("2", "1"), T("3", "2", "1")]);
console.assert(c.nodes.find((x) => x.n === "3")!.col === 2, "column is 1 + the longest chain");
console.assert(dagLayout([]).cols === 1, "an empty set is just MERGE");
console.log("ticketdag checks ran");
