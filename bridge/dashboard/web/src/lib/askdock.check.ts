// Run: node bridge/dashboard/web/src/lib/askdock.check.ts
import { descBlocks, descInline, docked, splitAsk, waited } from "./askdock.ts";
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
// A point inside a number or a word is no sentence end (the headline read "4 and file them as tickets?").
const w = splitAsk("The round came back at 8.4 with two findings. Should I fix both, or ship 8.4 and file them as tickets?");
console.assert(w.ctx === "The round came back at 8.4 with two findings." && w.ask === "Should I fix both, or ship 8.4 and file them as tickets?", `decimal: ${JSON.stringify(w)}`);
const y = splitAsk("Two found. Should I use a helper, e.g. the merge one?");
console.assert(y.ctx === "Two found." && y.ask === "Should I use a helper, e.g. the merge one?", `abbreviation: ${JSON.stringify(y)}`);
const x = splitAsk("Bump it to v1.2.3 in index.ts? Or keep it?");
console.assert(x.ctx === "Bump it to v1.2.3 in index.ts?" && x.ask === "Or keep it?", `dotted: ${JSON.stringify(x)}`);

console.assert(waited(100, 130) === "30s" && waited(100, 220) === "2m" && waited(undefined) === "", "waited");
console.log("askdock ok");

// A secret waits on the box like any card, and says only its name and why.
{
  const secret = turn("running", [{ type: "secret_request", request_id: "gw-1", name: "STRIPE_KEY", why: "Charges", at: 5 }], [{ request_id: "gw-1", kind: "secret", tool_name: "request_secret" }]);
  const d = docked([secret], true);
  if (d?.kind !== "secret" || d.requestId !== "gw-1" || d.name !== "STRIPE_KEY" || d.why !== "Charges" || d.of !== 1) throw new Error("a waiting secret docks");
  const answered = turn("running", [{ type: "secret_request", request_id: "gw-1", name: "K", why: "" }, { type: "secret_answered", request_id: "gw-1", given: true }], []);
  if (docked([answered], true) !== null) throw new Error("an answered secret doesn't");
  console.log("ok - a secret docks until it's answered");
}

// The text around the ask: "#38: … #18: …" run together becomes one item each,
// prose becomes paragraphs (.mystical/design-drafts/ask-description, B · RAIL).
{
  const eq = (a: unknown, b: unknown, why: string) => console.assert(JSON.stringify(a) === JSON.stringify(b), `${why}: ${JSON.stringify(a)}`);
  eq(descBlocks("#38: the badge is muted. #18: Proces › Betalen gets the scheme back. #23: wraps in Firefox too."),
    [{ items: [{ mark: "#38", text: "the badge is muted." }, { mark: "#18", text: "Proces › Betalen gets the scheme back." }, { mark: "#23", text: "wraps in Firefox too." }] }],
    "inline #NN items");
  eq(descBlocks("Four fixes. 1. Badge. 2) Button scheme. 3. Firefox wrap."),
    [{ p: "Four fixes." }, { items: [{ mark: "1", text: "Badge." }, { mark: "2", text: "Button scheme." }, { mark: "3", text: "Firefox wrap." }] }],
    "a lead, then numbered items");
  eq(descBlocks("Two ways:\n- keep it\n- drop it\n  and the table"),
    [{ p: "Two ways:" }, { items: [{ mark: "•", text: "keep it" }, { mark: "•", text: "drop it and the table" }] }],
    "dash lines, a continuation joins its item");
  eq(descBlocks("A: keep SQLite. B: move to Redis."),
    [{ items: [{ mark: "A", text: "keep SQLite." }, { mark: "B", text: "move to Redis." }] }], "lettered items");
  // One marker is no list, and numbers out of order are no list ("since 2. Then 7. done").
  eq(descBlocks("Fixed #38: it reads right."), [{ p: "Fixed #38: it reads right." }], "a lone #NN");
  eq(descBlocks("It shipped in v2. Then 7. Is fine."), [{ p: "It shipped in v2. Then 7. Is fine." }], "numbers out of order");
  eq(descBlocks("One. Two. Three. Four. Five."), [{ p: "One. Two." }, { p: "Three. Four. Five." }], "prose: two sentences a paragraph, a lone last one joins");
  eq(descBlocks("First para.\n\nSecond para."), [{ p: "First para." }, { p: "Second para." }], "blank line");

  eq(descInline("reads `name · 1` with **the code** muted"),
    [{ t: "reads " }, { code: "name · 1" }, { t: " with " }, { b: "the code" }, { t: " muted" }], "code and bold");
  eq(descInline('reads "name · 18-01-4" now'), [{ t: "reads " }, { code: "name · 18-01-4" }, { t: " now" }], "a quoted literal");
  eq(descInline("Proces › Betalen (process › payment) gets it (later)"),
    [{ t: "Proces" }, { crumb: true }, { t: "Betalen " }, { gloss: "(process › payment)" }, { t: " gets it (later)" }], "crumb + gloss, a plain aside stays");
  eq(descInline("Beheer › Producten (settings) warns"),
    [{ t: "Beheer" }, { crumb: true }, { t: "Producten " }, { gloss: "(settings)" }, { t: " warns" }], "gloss right after a crumb path");
  console.log("ok - the description formats");
}
