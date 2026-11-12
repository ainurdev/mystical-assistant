// Run: node bridge/dashboard/web/src/lib/guessmode.check.ts
// flow-gear 07: GUESS BY HAND. The box never guesses; a tap or Tab still lights a flow.
import { nextKind, sendPlan, shownKind } from "./kinds.ts";

const auto = { start: true, design: true };
const hand = { ...auto, hand: true };
const prompts = ["add avatar with its border to inbox header as well", "the session list jumps when a turn ends",
  "merge this into master locally then clean up", "what is not pushed on my local branches?", "better ui for the plugins tab"];

for (const p of prompts) {
  console.assert(shownKind(null, p, auto).kind !== null, `AUTO guesses: ${p}`);
  console.assert(shownKind(null, p, hand).kind === null && shownKind(null, p, hand).how === "none", `BY HAND guesses nothing: ${p}`);
}

// A tap lights it under BY HAND, and the send starts the flow as yours.
const tapped = shownKind("build", prompts[0], hand);
console.assert(tapped.kind === "build" && tapped.how === "picked", "a tap lights BUILD");
const plan = sendPlan({ kind: tapped.kind, how: tapped.how, text: prompts[0], running: null, flows: true, answering: false, agent: false, run: null });
console.assert(plan.flow === "build" && plan.by === "you", "the tapped flow goes with the send");

// Tab cycles under BY HAND as under AUTO: from nothing lit to the first flow.
console.assert(nextKind(null, 1) === "design", "Tab lights a flow");
const tabbed = shownKind(nextKind(null, 1), prompts[0], hand);
console.assert(tabbed.kind === "design" && tabbed.how === "picked", "a Tab pick shows under BY HAND");

// Nothing lit: the send carries no flow, so NO KIND (the bridge's routing text) decides.
const none = shownKind(null, prompts[0], hand);
const bare = sendPlan({ kind: none.kind, how: none.how, text: prompts[0], running: null, flows: true, answering: false, agent: false, run: null });
console.assert(bare.flow === undefined && bare.text === prompts[0], "no flow lit: sent as typed, no flow");
