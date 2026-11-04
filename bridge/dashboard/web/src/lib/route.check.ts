// Run: node bridge/dashboard/web/src/lib/route.check.ts
import { SMART_ZONE, ghostFor, isDropped, isStale, shouldAutoApply } from "./route.ts";
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

console.log("route.check: ok");
