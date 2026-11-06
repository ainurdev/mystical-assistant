// Run: node bridge/miniapp/web/src/lib/admonition.check.ts
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripMarker } from "./admonition.ts";

// What react-markdown hands a callout's <blockquote>: blocks with newlines between.
const box = (...kids: unknown[]) => renderToStaticMarkup(h("div", null, stripMarker(kids) as never));

// The to-do box replies open with: the marker alone on its line, then a list.
const list = box("\n", h("p", { key: 1 }, "[!IMPORTANT]"), "\n", h("ul", { key: 2 }, h("li", null, "Turn FileVault on.")), "\n");
console.assert(!list.includes("[!") && !list.includes("<p>") && list.includes("<li>Turn FileVault on.</li>"),
  `marker paragraph goes: ${list}`);

// Marker and text in one paragraph, its line ended by remark-breaks' <br>.
const text = box("\n", h("p", { key: 1 }, "[!NOTE]", h("br", { key: 2 }), "\n", "Some text."), "\n");
console.assert(!text.includes("[!") && !text.includes("<br") && text.includes("<p>\nSome text.</p>"),
  `marker line and its <br> go: ${text}`);
