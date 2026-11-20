// GitHub callouts as Markdown.tsx draws them: the marker that names a box, and
// the quote's children with that marker cut out. Kept out of the component so
// admonition.check.ts runs it under node; the Mini App's lib/admonition.ts is a copy.
import { cloneElement, isValidElement, type ReactNode } from "react";

/** A GitHub callout's marker, `> [!NOTE]` and friends, at the head of a quote. */
export const ADMONITION_RE = /^\s*\[!(note|tip|important|warning|caution|insight)\]\s*\n?/i;

const blank = (n: unknown) => n === null || n === undefined || (typeof n === "string" && !n.trim());

/** A callout quote's children with the `[!NOTE]` marker cut out. The marker is
 *  the leading text of the leading paragraph, but the newline between blocks is
 *  a child too, so it's skipped. A paragraph that held only the marker goes, and
 *  so does the <br> remark-breaks ends the marker's line with: the box opens on
 *  its content. */
export function stripMarker(node: unknown): unknown {
  if (typeof node === "string") return node.replace(ADMONITION_RE, "");
  if (Array.isArray(node)) {
    const i = node.findIndex((n) => !blank(n));
    if (i < 0) return node;
    const head = stripMarker(node[i]);
    let rest = node.slice(i + 1);
    const next = rest.findIndex((n) => !blank(n));
    if (!head && isValidElement(rest[next]) && rest[next].type === "br") rest = rest.slice(next + 1);
    return [...node.slice(0, i), head, ...rest];
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: unknown };
    if (props.children === undefined) return node;
    const kids = stripMarker(props.children);
    return kids === "" ? null : cloneElement(node, undefined, kids as ReactNode);
  }
  return node;
}

// The Explanatory and Learning Output styles' teaching note (bridge/outputstyles.py): Claude
// writes a rule in backticks, `★ Insight ───`, its points, and a closing `───` rule.
const INSIGHT_OPEN = /^\s*`★ Insight[^`]*`\s*$/;
const INSIGHT_CLOSE = /^\s*`─+`\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** A reply's Insight notes as `> [!INSIGHT]` callouts, so the callout box draws them. One
 *  still streaming (no closing rule yet) runs to the end, so the box grows with it. A fenced
 *  block that quotes the marker stays code. */
export function insightCallouts(md: string): string {
  if (!md.includes("★ Insight")) return md;
  const out: string[] = [];
  let fence = false, inside = false;
  for (const line of md.split("\n")) {
    if (inside) {
      if (INSIGHT_CLOSE.test(line)) {
        inside = false;
        out.push("");                    // what follows the note isn't part of it
      } else out.push(line.trim() ? `> ${line}` : ">");
      continue;
    }
    if (FENCE.test(line)) fence = !fence;
    if (!fence && INSIGHT_OPEN.test(line)) {
      inside = true;
      out.push("> [!INSIGHT]");
    } else out.push(line);
  }
  return out.join("\n");
}
