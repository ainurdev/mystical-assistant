// Run: node bridge/miniapp/web/src/lib/toolwidget.check.ts
//
// The mapping is the whole feature, and its one safety property is that a
// result it doesn't recognise keeps the plain row it always had. That is what
// this checks — not how the widgets look.

import { readFileSync } from "node:fs";
import { CHAT_BGS, isToolStyle, shotName, toChatBg, toToolStyle, widgetForRun, TOOL_STYLES } from "./toolwidget.ts";

// --- the table --------------------------------------------------------------
const src = widgetForRun([{ done: { sources: [{ url: "https://a.dev", title: "A" }] } }]);
console.assert(src?.type === "sources", `sources -> SOURCES, got ${src?.type}`);
console.assert(src?.meta === "1", `meta counts the rows, got ${src?.meta}`);

const shot = widgetForRun([{ done: { images: ["/u/a.png", "/u/b.png"] } }]);
console.assert(shot?.type === "screens", `images -> SCREENS, got ${shot?.type}`);
console.assert(shot?.meta === "2", "meta counts the shots");

// --- nothing to draw keeps the plain row ------------------------------------
console.assert(widgetForRun([{}]) === null, "a tool still running has no widget");
console.assert(widgetForRun([{ done: {} }]) === null, "a bare result keeps its one-line row");
console.assert(widgetForRun([{ done: { sources: [] } }]) === null, "an empty list is not a widget");
console.assert(widgetForRun([{ done: { images: [] } }]) === null, "no shots is not a gallery");

// A tool with no table entry — Grep, TodoWrite, anything added upstream — must
// fall through rather than half-draw. This is the regression that matters.
console.assert(
  widgetForRun([{ done: { stat: "6 files" } as { images?: string[] } }]) === null,
  "an unmapped tool keeps its stat line",
);

// --- what a shot is called --------------------------------------------------
// The caption comes from the call, because the file it was saved as is an id.
console.assert(shotName("http://127.0.0.1:8899/dashboard-a-rail.html") === "dashboard-a-rail.html",
  `a url is named by its page, got ${shotName("http://127.0.0.1:8899/dashboard-a-rail.html")}`);
console.assert(shotName("https://a.dev/x/y?q=1#z") === "y", `query and hash are not the name, got ${shotName("https://a.dev/x/y?q=1#z")}`);
console.assert(shotName("http://127.0.0.1:8790/") === "127.0.0.1:8790",
  `a bare host still names itself, got ${shotName("http://127.0.0.1:8790/")}`);
console.assert(shotName("/home/u/shot1.png") === "shot1.png", "a path is named by its file");
console.assert(shotName("") === "", "nothing to name it by falls back to the number");
const named = widgetForRun([{ done: { images: ["/u/mcp-toolu-1-0.png"] }, summary: "http://x.dev/page.html" }]);
console.assert((named?.value as { caption?: string }[])[0].caption === "page.html",
  "the call captions its shot");
const pair = widgetForRun([{ done: { images: ["/u/a.png", "/u/b.png"] }, summary: "http://x.dev/page.html" }]);
console.assert((pair?.value as { caption?: string }[])[1].caption === "page.html · 2",
  "one call's several frames are numbered under one name");

// --- a run of results is ONE widget -----------------------------------------
// A group is drawn by its head, so anything a member returned has to be folded
// into the head's widget or it is drawn by nobody.
const chain = widgetForRun([{ done: { images: ["/u/a.png"] } }, {}, { done: { images: ["/u/b.png"] } }]);
console.assert(chain?.type === "screens", `a run of shots is one gallery, got ${chain?.type}`);
console.assert(chain?.meta === "2", `both members' shots are in it, got ${chain?.meta}`);
const webchain = widgetForRun([{ done: { sources: [{ url: "https://a.dev" }] } }, { done: { sources: [{ url: "https://b.dev" }] } }]);
console.assert(webchain?.meta === "2", `a run of fetches is one source list, got ${webchain?.meta}`);
console.assert(widgetForRun([{}, { done: {} }]) === null, "a run that carried nothing keeps its rows plain");

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

// --- the ground -------------------------------------------------------------
// A key with no CSS rule behind it is a tile that draws nothing and reads
// exactly like NONE, so the list is checked against the stylesheet.
console.assert(CHAT_BGS.length === 5, `four grounds and NONE, got ${CHAT_BGS.length}`);
console.assert(toChatBg("grid") === "grid", "a current ground passes through");
console.assert(toChatBg("wallpaper") === "none", "an unknown ground falls back");
{
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  for (const b of CHAT_BGS.slice(1))
    console.assert(css.includes(`[data-bg="${b.key}"]`), `${b.key} has a rule in index.css`);
}

console.log("toolwidget: ok");
