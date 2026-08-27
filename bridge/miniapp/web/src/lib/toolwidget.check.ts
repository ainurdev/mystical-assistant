// Run: node bridge/miniapp/web/src/lib/toolwidget.check.ts
//
// The mapping is the whole feature, and its one safety property is that a
// result it doesn't recognise keeps the plain row it always had. That is what
// this checks — not how the widgets look.

import { isToolStyle, toToolStyle, widgetFor, TOOL_STYLES } from "./toolwidget.ts";

// --- the table --------------------------------------------------------------
const src = widgetFor({ sources: [{ url: "https://a.dev", title: "A" }] });
console.assert(src?.type === "sources", `sources -> SOURCES, got ${src?.type}`);
console.assert(src?.meta === "1", `meta counts the rows, got ${src?.meta}`);

const shot = widgetFor({ images: ["/u/a.png", "/u/b.png"] });
console.assert(shot?.type === "screens", `images -> SCREENS, got ${shot?.type}`);
console.assert(
  JSON.stringify(shot?.value) === JSON.stringify([{ path: "/u/a.png" }, { path: "/u/b.png" }]),
  "images become the {path} rows asScreens wants",
);
console.assert(shot?.meta === "2", "meta counts the shots");

// --- nothing to draw keeps the plain row ------------------------------------
console.assert(widgetFor(undefined) === null, "a tool still running has no widget");
console.assert(widgetFor({}) === null, "a bare result keeps its one-line row");
console.assert(widgetFor({ sources: [] }) === null, "an empty list is not a widget");
console.assert(widgetFor({ images: [] }) === null, "no shots is not a gallery");

// A tool with no table entry — Grep, TodoWrite, anything added upstream — must
// fall through rather than half-draw. This is the regression that matters.
console.assert(
  widgetFor({ stat: "6 files" } as Parameters<typeof widgetFor>[0]) === null,
  "an unmapped tool keeps its stat line",
);

// --- the style setting ------------------------------------------------------
console.assert(TOOL_STYLES.length === 5, `five styles, got ${TOOL_STYLES.length}`);
console.assert(TOOL_STYLES[0].key === "stamp", "CONTROL PLATE is the default, and leads");
for (const s of TOOL_STYLES) console.assert(isToolStyle(s.key), `${s.key} is a style`);
console.assert(!isToolStyle("fancy"), "an unknown style is rejected (a stale localStorage value)");
console.assert(!isToolStyle(undefined), "a missing style is rejected");
// The sheet replaced all four; a pick made before it lands on its nearest new
// language rather than snapping back to the default.
console.assert(toToolStyle("instrument") === "stamp", "INSTRUMENT was redrawn as CONTROL PLATE");
console.assert(toToolStyle("terminal") === "wire", "TERMINAL was redrawn as WIRE");
console.assert(toToolStyle("note") === "press", "NOTE was redrawn as LEDGER PRESS");
console.assert(toToolStyle("plain") === "wire", "PLAIN had no column; it lands on the quietest");
console.assert(toToolStyle("bare") === "wire", "BARE, two renames ago, still resolves");
console.assert(toToolStyle("card") === "press", "CARD, two renames ago, still resolves");
console.assert(toToolStyle("halo") === "halo", "a current style passes through");
console.assert(toToolStyle("fancy") === "stamp", "an unknown style falls back");
console.assert(toToolStyle(undefined) === "stamp", "a missing style falls back");

console.log("toolwidget: ok");
