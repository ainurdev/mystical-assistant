// Run: node bridge/dashboard/web/src/lib/route.check.ts
import { SMART_ZONE, caption, ghostFor, isDropped, isStale, shouldAutoApply, swapLead } from "./route.ts";
import type { Route } from "../api.ts";

const base: Route = { name: "", desc: "", why: "", auto: false, arg: "", fresh: false, kind: "start", alts: [] };
const GRILL = "mattpocock-skills:grill-with-docs";
// The three routes the server hands out: an auto pick for a typed feature prompt, a dashed
// suggestion for one it only half-recognises, and the next step once a flow command ended.
const auto: Route = { ...base, name: GRILL, desc: "Grill the plan", why: "a feature: settle the design first", auto: true };
const suggest: Route = { ...base, name: "mattpocock-skills:code-review", desc: "Review the diff", why: "reads like a review" };
const next: Route = { ...base, name: "mattpocock-skills:to-spec", desc: "Write the spec", why: "the grill is settled", arg: "the decisions above", kind: "next" };

console.assert(SMART_ZONE === 150_000, "mirrors SMART_ZONE in bridge/route.py");

// --- shouldAutoApply -------------------------------------------------------
console.assert(shouldAutoApply("add dark mode to the settings page", auto, false), "auto applies to a typed feature prompt");
console.assert(!shouldAutoApply("add dark mode to the settings page", null, false), "no route, nothing to apply");
console.assert(!shouldAutoApply("add dark mode to the settings page", suggest, false), "a suggestion is never applied by itself");
console.assert(!shouldAutoApply("/compact", auto, false), "never over a /command the user typed");
console.assert(!shouldAutoApply(`/${GRILL} add x`, auto, false), "never once the command is already there");
console.assert(!shouldAutoApply("", auto, false) && !shouldAutoApply("  \n", auto, false), "nothing typed, nothing to put a command in front of");

// --- Review Focus 2: Backspace on an auto-applied command ---------------------
const gone = "add dark mode to the settings page";
console.assert(isDropped("add x", GRILL) === true, "the command was cut out of the draft");
console.assert(isDropped(`/${GRILL} add x`, GRILL) === false, "still leading: not dropped");
console.assert(isDropped(`/${GRILL.slice(0, -1)} add x`, GRILL) === true, "a Backspace into the name drops it too");
console.assert(isDropped("add x", null) === false, "nothing was applied, so nothing can be dropped");
console.assert(isDropped("", null) === false, "an emptied draft starts clean");
console.assert(!shouldAutoApply(gone, auto, isDropped(gone, GRILL)), "after Backspace the command stays gone...");
console.assert(!shouldAutoApply(gone + " and a toggle", auto, true), "...while the same draft is edited");
console.assert(shouldAutoApply(gone, auto, false), "a fresh draft (dropped reset on empty) can be routed again");

// --- ghostFor ----------------------------------------------------------------
console.assert(ghostFor("", next)?.arg === next.arg, "empty box: the next step shows its suggested arg");
console.assert(ghostFor("", next)?.name === next.name && ghostFor("", next)?.desc === next.desc, "name and desc pass through");
console.assert(ghostFor("fix the login bug", next)?.arg === "", "typed text: the suggested arg goes, the text is the arg");
console.assert(JSON.stringify(ghostFor("fix the login bug", suggest)) === JSON.stringify({ name: suggest.name, desc: suggest.desc, arg: "" }), "exactly name, desc, arg");
console.assert(ghostFor("add", auto) === null, "an auto route with text is applied solid, never drawn dashed");
console.assert(ghostFor("add", null) === null, "no route, no ghost");
console.assert(ghostFor("/tdd", next) === null, "no ghost over a /command the user typed");
console.assert(ghostFor("/", suggest) === null, "not even over a bare /");

// --- Review Focus 3: a late route response -------------------------------------
console.assert(!isStale("add x", "add x", 3, 3), "same text, same fetch: fresh");
console.assert(isStale("add x", "add xy", 3, 3), "text changed since the fetch went out");
console.assert(isStale("add x", "add x", 3, 4), "a newer fetch went out for the same text");
console.assert(isStale("add x", "", 3, 4), "sent: the box was cleared and a newer fetch started");
console.assert(isStale("add x", "", 3, 3), "sent: the box was cleared");
console.assert(isStale("add x", "add xy", 3, 4), "both changed");

// --- caption: the line under the box, per kind and per where the command is drawn ---
const cap = (r: Route, how: "auto" | "inline" | "row") => { const c = caption(r, how); return [c.tag, c.tone ?? "", c.why, ...c.tail.flat()].join("|"); };
const ask: Route = { ...base, name: "mattpocock-skills:ask-matt", kind: "ask", why: "x" };
const setup: Route = { ...base, kind: "setup", why: "once per repo" };
const compact: Route = { ...next, name: "compact", why: "162k is past the 150k smart zone", arg: "keep the decisions so far; next: /to-spec" };
// Esc, not ⌫: the caret sits at the end of the text after the pick, where ⌫ would cost a character of yours
console.assert(cap(auto, "auto") === "AUTO||a feature: settle the design first|Esc|drops it||click it for other fits", "auto: why, then Esc and the other fits");
console.assert(cap({ ...auto, kind: "next" }, "auto").startsWith("AUTO|"), "auto wins over the kind");
// an empty box: the ghost is in front of where the text will go
console.assert(cap(next, "inline") === "NEXT||the grill is settled|Tab|takes it", "a next step");
console.assert(cap({ ...next, fresh: true }, "inline") === "NEXT||the grill is settled|Tab|opens it in a fresh session", "a ticket opens in a fresh session");
console.assert(cap(compact, "inline") === "NEXT|warn|162k is past the 150k smart zone|Tab|takes it||then /to-spec", "compact: warn, then the step it makes room for");
console.assert(cap({ ...compact, arg: "" }, "inline") === "NEXT|warn|162k is past the 150k smart zone|Tab|takes it", "no step named, no then");
console.assert(cap(setup, "inline") === "ONCE||once per repo|Tab|takes it|Esc|hides it for this repo", "setup on an empty box: Esc hides it for this repo");
// a box with text: the suggestion sits in the caption row, so Tab puts it in front of the text
console.assert(cap(suggest, "row") === "ROUTE||reads like a review|Tab|puts it in front", "a start suggestion in the row");
console.assert(cap(ask, "row") === "NO CLEAR FIT|dim||Tab|puts /ask-matt in front, it names the flow||ignore it to send as typed", "ask in the row: no why, its own copy");
console.assert(cap(setup, "row") === "ONCE||once per repo|Tab|puts it in front|Esc|hides it for this repo", "setup in the row");
console.assert(cap(next, "row") === cap(next, "inline") && cap(compact, "row") === cap(compact, "inline"), "next steps read the same wherever they are drawn");

// --- swapLead: a pick from the other fits, or Send as typed --------------------------
console.assert(swapLead(`/${GRILL} add x`, GRILL, "mattpocock-skills:prototype") === "/mattpocock-skills:prototype add x", "swaps the command, keeps the text");
console.assert(swapLead(`/${GRILL} add x`, GRILL, null) === "add x", "Send as typed takes the command and its space out");
console.assert(swapLead(`/${GRILL} `, GRILL, null) === "" && swapLead(`/${GRILL}`, GRILL, "a") === "/a ", "nothing after the command");
console.assert(swapLead(`/${GRILL}\nadd x`, GRILL, null) === "\nadd x", "a newline after it stays, as Backspace leaves it");

console.log("route.check: ok");
