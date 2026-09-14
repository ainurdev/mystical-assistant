// Run: node bridge/dashboard/web/src/lib/selmd.check.ts
import { fragmentMd } from "./selmd.ts";

// Just enough of a DOM node for the walker: type, tag, children, text, attrs.
type N = { nodeType: number; tagName?: string; childNodes: N[]; textContent: string; getAttribute: (k: string) => string | null };
const t = (s: string): N => ({ nodeType: 3, childNodes: [], textContent: s, getAttribute: () => null });
const h = (tag: string, attrs: Record<string, string>, ...kids: (N | string)[]): N => {
  const childNodes = kids.map((k) => (typeof k === "string" ? t(k) : k));
  return {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes,
    get textContent() { return childNodes.map((c) => c.textContent).join(""); },
    getAttribute: (k) => attrs[k] ?? null,
  };
};
// What selectionMd does to the walker's output.
const md = (...kids: (N | string)[]) =>
  fragmentMd(h("frag", {}, ...kids) as unknown as Node).replace(/\n{3,}/g, "\n\n").trim();

const eq = (got: string, want: string, what: string) =>
  console.assert(got === want, `${what}:\n--- got\n${got}\n--- want\n${want}`);

eq(md(h("h2", {}, "Title"), "\n", h("p", {}, "A ", h("strong", {}, "bold"), " and ", h("code", {}, "x"), ".")),
  "## Title\n\nA **bold** and `x`.", "heading + inline");
eq(md(h("ul", {}, h("li", {}, "one"), "\n", h("li", {}, "two", h("ul", {}, h("li", {}, "deep"))))),
  "- one\n- two\n  - deep", "nested list");
eq(md(h("ol", {}, h("li", {}, h("input", { type: "checkbox", checked: "" }), "done"), h("li", {}, h("input", { type: "checkbox" }), "todo"))),
  "1. [x] done\n2. [ ] todo", "task list");
eq(md(h("div", { class: "md-code" }, h("div", { class: "md-code-lang" }, "ts"), h("pre", {}, h("code", {}, "let a = 1;\n")))),
  "```ts\nlet a = 1;\n```", "fenced code");
eq(md(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "a"), h("th", {}, "b"))), h("tbody", {}, h("tr", {}, h("td", {}, "1"), h("td", {}, "2"))))),
  "| a | b |\n| --- | --- |\n| 1 | 2 |", "table");
eq(md(h("blockquote", {}, h("p", {}, "see ", h("a", { href: "https://x" }, "x")))),
  "> see [x](https://x)", "quote + link");
eq(md(h("div", { class: "md-admonition" }, h("div", { class: "md-admonition-label" }, "NOTE"), h("p", {}, "careful"))),
  "> [!NOTE]\n> careful", "admonition");
eq(md(h("p", {}, "a"), h("hr", {}), h("p", {}, "b")), "a\n\n---\n\nb", "rule between paragraphs");

console.log("selmd ok");

// The copy glyph (CopyBtn in components/Markdown.tsx) is icon-only so that a
// selection dragged across it contributes nothing to the markdown.
eq(md(h("blockquote", {}, h("button", { class: "md-copy" }, h("svg", {})), h("p", {}, "quoted"))),
  "> quoted", "copy glyph adds nothing to a quote");
eq(md(h("p", {}, h("a", { href: "https://x.y" }, "x"), h("button", { class: "md-copy" }, h("svg", {})), " end")),
  "[x](https://x.y) end", "copy glyph adds nothing after a link");
