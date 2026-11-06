import { cloneElement, isValidElement, type ReactNode } from "react";

/** A GitHub callout's marker, `> [!NOTE]` and friends, at the head of a quote. */
export const ADMONITION_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*\n?/i;

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
