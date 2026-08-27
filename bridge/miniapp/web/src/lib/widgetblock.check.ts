// Run: node bridge/miniapp/web/src/lib/widgetblock.check.ts
//
// The safety property is the only thing worth checking: a fence that isn't a
// well-formed widget must fall through to the code block it already drew. A
// block streaming in is malformed for most of its life, so "malformed" is the
// common case, not the edge one.

import { widgetLang, widgetValue } from "./widgetblock.ts";
import { idiomFor, WIDGET_TYPES } from "./toolwidget.ts";

// --- the language tag -------------------------------------------------------
console.assert(widgetLang("widget:checks") === "checks", "colon spelling");
console.assert(widgetLang("widget-checks") === "checks", "hyphen spelling");
console.assert(widgetLang("WIDGET:Checks") === "checks", "case-insensitive, lowered");
console.assert(widgetLang("  widget:table  ") === "table", "surrounding space is trimmed");
console.assert(widgetLang("ts") === null, "an ordinary fence is not a widget");
console.assert(widgetLang("") === null, "a fence with no language is not a widget");
console.assert(widgetLang("widget") === null, "a bare 'widget' names no type");
console.assert(widgetLang("widget:") === null, "an empty type is rejected");
console.assert(widgetLang("widgetry:checks") === null, "the prefix must be exact");

// --- the body ---------------------------------------------------------------
console.assert(
  JSON.stringify(widgetValue('[{"cmd":"a","ok":true}]')) === '[{"cmd":"a","ok":true}]',
  "well-formed JSON comes back parsed",
);
console.assert(widgetValue("") === null, "an empty body is not a value");
console.assert(widgetValue("   ") === null, "whitespace is not a value");
console.assert(widgetValue("[{\"cmd\":") === null, "a half-streamed block falls through");
console.assert(widgetValue("just prose") === null, "prose in a widget fence falls through");
console.assert(widgetValue('"a string"') === null, "a bare scalar is not a widget payload");
console.assert(widgetValue("42") === null, "a bare number is not a widget payload");

// --- every named type lands somewhere on the ladder -------------------------
for (const t of WIDGET_TYPES) {
  const i = idiomFor(t);
  console.assert(
    ["trace", "strip", "ledger", "plate", "field"].includes(i),
    `${t} -> a real idiom, got ${i}`,
  );
}
console.assert(WIDGET_TYPES.length === 21, `21 widget types, got ${WIDGET_TYPES.length}`);
// An unknown type still has to frame: the model can invent a name, and the
// fallback must be the idiom that assumes least, not a crash.
console.assert(idiomFor("nonesuch") === "strip", "an unknown type falls back to strip");

console.log("widgetblock: ok");
