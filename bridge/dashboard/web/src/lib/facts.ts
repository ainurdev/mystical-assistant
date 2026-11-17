// An answer's facts (.mystical/design-drafts/session-one-feel, C · SPINE): a list whose every
// item opens with a bold label ("**Merge:** a fast-forward") reads as label · text rows, not
// bullets. Markdown.tsx tags such a list `.md-facts`; the spine's answer card lays it out.
import type { Element, ElementContent } from "hast";

/** A bold that is really a label: short, one line, ending in a colon. */
export const LEAD_RE = /^[^\n]{2,24}:$/;

const textOf = (n: ElementContent): string =>
  n.type === "text" ? n.value : n.type === "element" ? n.children.map(textOf).join("") : "";
const blank = (n: ElementContent) => n.type === "text" && !n.value.trim();
const first = (kids: ElementContent[]) => kids.find((k) => !blank(k));

/** Every item of the list opens with a lead-in label. */
export function isFactList(ul: Element): boolean {
  const items = ul.children.filter((c): c is Element => c.type === "element" && c.tagName === "li");
  return items.length > 0 && items.every((li) => {
    let head = first(li.children);
    // A loose list's item holds a paragraph: the label leads that.
    if (head?.type === "element" && head.tagName === "p") head = first(head.children);
    return head?.type === "element" && head.tagName === "strong" && LEAD_RE.test(textOf(head).trim());
  });
}
