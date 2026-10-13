// Run: node bridge/dashboard/web/src/lib/banner.check.ts
import { bannerActions, bannerAnswer, bannerBody } from "./banner.ts";

const perm = { request_id: "r1", kind: "permission" as const, tool_name: "Bash", summary: "rm -rf dist" };
console.assert(bannerActions(perm).map((b) => b.action).join() === "allow,deny", "permission → Allow/Deny");
console.assert(JSON.stringify(bannerAnswer(perm, "deny")) === JSON.stringify({ request_id: "r1", behavior: "deny" }), "deny body");
console.assert(bannerAnswer(perm, "opt:0") === null, "a permission takes no option");
console.assert(bannerBody(perm) === "Bash: rm -rf dist", "permission body");

const q = { request_id: "r2", kind: "question" as const, questions: [{ question: "Which?", header: "Approach", options: [{ label: "A" }, { label: "B" }] }] };
console.assert(bannerActions(q).map((b) => b.title).join() === "A,B", "one question → its options");
console.assert(JSON.stringify(bannerAnswer(q, "opt:1")) === JSON.stringify({ request_id: "r2", answers: [{ header: "Approach", labels: ["B"] }] }), "option body");
console.assert(bannerAnswer(q, "opt:7") === null, "unknown option");
console.assert(bannerBody(q) === "Which?", "question body");

const multi = { ...q, questions: [{ ...q.questions[0], multiSelect: true }] };
console.assert(bannerActions(multi).length === 0, "multi-select gets no buttons");
const two = { ...q, questions: [q.questions[0], q.questions[0]] };
console.assert(bannerActions(two).length === 0, "two questions get no buttons");
const five = { ...q, questions: [{ ...q.questions[0], options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })) }] };
console.assert(bannerActions(five).length === 0, "five options get no buttons");
const long = { ...q, questions: [{ ...q.questions[0], options: [{ label: "x".repeat(60) }] }] };
console.assert(bannerActions(long)[0].title.length === 40, "long labels are clipped");
console.assert(bannerActions(undefined).length === 0 && bannerAnswer(undefined, "allow") === null, "no card, nothing");
console.log("banner.check ok");
