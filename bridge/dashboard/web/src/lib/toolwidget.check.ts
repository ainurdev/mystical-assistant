// Run: node bridge/dashboard/web/src/lib/toolwidget.check.ts
//
// The mapping is the whole feature, and its one safety property is that a
// result it doesn't recognise keeps the plain row it always had. That is what
// this checks — not how the widgets look.

import { isToolStyle, widgetFor, TOOL_STYLES } from "./toolwidget.ts";

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
console.assert(TOOL_STYLES.length === 4, `four styles, got ${TOOL_STYLES.length}`);
console.assert(TOOL_STYLES[0].key === "instrument", "instrument is the default, and leads");
for (const s of TOOL_STYLES) console.assert(isToolStyle(s.key), `${s.key} is a style`);
console.assert(!isToolStyle("fancy"), "an unknown style is rejected (a stale localStorage value)");
console.assert(!isToolStyle(undefined), "a missing style is rejected");

console.log("toolwidget: ok");
