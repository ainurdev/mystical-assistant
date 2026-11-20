// Run: node bridge/miniapp/web/src/lib/admonition.check.ts
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMONITION_RE, insightCallouts, stripMarker } from "./admonition.ts";

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

// The Explanatory and Learning Output styles' teaching note: a ★ Insight rule in backticks,
// its points, a closing rule. It becomes a callout, so the box above draws it.
const note = "Done.\n`★ Insight ─────────────────────────────────────`\n- Hooks run in order.\n\n" +
  "- The cache is per file.\n`─────────────────────────────────────────────────`\nNext: tests.";
const got = insightCallouts(note);
console.assert(got === "Done.\n> [!INSIGHT]\n> - Hooks run in order.\n>\n> - The cache is per file.\n\nNext: tests.",
  `an insight becomes a callout, and the text after it stays out: ${JSON.stringify(got)}`);
console.assert(ADMONITION_RE.test("[!INSIGHT]\n- a point"), "the box knows the insight marker");
// Still streaming: no closing rule yet, so the box runs to the end and grows with it.
console.assert(insightCallouts("`★ Insight ─────`\n- Half") === "> [!INSIGHT]\n> - Half", "an open insight runs to the end");
// Code that quotes the marker stays code, and other text is untouched.
const fenced = "```\n`★ Insight ───`\nx\n`───`\n```";
console.assert(insightCallouts(fenced) === fenced, "a fenced block is left alone");
console.assert(insightCallouts("a `★ Insight` mid-line") === "a `★ Insight` mid-line", "only a note's own line opens one");
