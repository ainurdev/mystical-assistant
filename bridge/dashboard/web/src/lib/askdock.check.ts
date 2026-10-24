// Run: node bridge/dashboard/web/src/lib/askdock.check.ts
import { docked, splitAsk, waited } from "./askdock.ts";
import type { Turn } from "../chat.ts";

const q = { header: "Ship", question: "When?", options: [{ label: "Now", description: "" }] };
const turn = (status: Turn["status"], events: Turn["events"], pending: Turn["pending"] = []): Turn =>
  ({ id: "t1", prompt: "p", status, events, pending });

// A running turn docks its first open card; answered ones don't count.
const live = turn("running", [
  { type: "permission", request_id: "p0", tool_name: "Bash", summary: "ls" },
  { type: "permission_resolved", request_id: "p0", behavior: "allow" },
  { type: "question", request_id: "q1", questions: [q] },
  { type: "permission", request_id: "p2", tool_name: "Bash", summary: "git push", detail: "git push origin master" },
], [{ request_id: "q1", kind: "question", tool_name: "AskUserQuestion" }, { request_id: "p2", kind: "permission", tool_name: "Bash" }]);
const d = docked([live], true)!;
console.assert(d.kind === "question" && d.requestId === "q1" && d.of === 2, `first open card: ${JSON.stringify(d)}`);
console.assert(docked([turn("running", live.events, [])], true) === null, "nothing pending, nothing docked");

// A done turn docks the question its answer ended on — unless prose is off.
const done = turn("done", [{ type: "result", result: "Built it.\n\nShould I push?", cost: 0, elapsed: 1 }]);
const p = docked([done], true)!;
console.assert(p.kind === "prose" && p.ask.question === "Should I push?", `prose: ${JSON.stringify(p)}`);
console.assert(docked([done], false) === null, "prose off");
console.assert(docked([turn("done", [{ type: "result", result: "Unknown command: /x?", cost: 0, elapsed: 0 }])], true) === null, "unknown command");
console.assert(docked([turn("done", [{ type: "result", result: "Failed?", cost: 0, elapsed: 0, is_error: true }])], true) === null, "error");

// The ask is the last "?" sentence; context before it, a hint after it.
const s = splitAsk("It is built (4fae5147, not pushed). 4 sessions run. When should I ship it?");
console.assert(s.ctx === "It is built (4fae5147, not pushed). 4 sessions run." && s.ask === "When should I ship it?" && s.tail === "", `split: ${JSON.stringify(s)}`);
const t = splitAsk("Which extras should come with it? Pick any, or none.");
console.assert(t.ask === "Which extras should come with it?" && t.tail === "Pick any, or none." && !t.ctx, `tail: ${JSON.stringify(t)}`);
console.assert(splitAsk("Pick a colour.").ask === "Pick a colour.", "no question mark: all of it is the ask");
const v = splitAsk("Two ways to go.\nWhich one?");
console.assert(v.ctx === "Two ways to go." && v.ask === "Which one?", `newline: ${JSON.stringify(v)}`);

console.assert(waited(100, 130) === "30s" && waited(100, 220) === "2m" && waited(undefined) === "", "waited");
console.log("askdock ok");
