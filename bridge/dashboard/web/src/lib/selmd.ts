/* The selection, as the markdown that drew it. A reply is rendered through
   react-markdown, so what the browser copies is the view: bullets, fences,
   headings, links and tables flattened to lines. This walks the selected DOM
   fragment and writes back the markdown for the element set react-markdown +
   remark-gfm and Markdown.tsx's own wrappers (.md-code, .md-admonition)
   produce; anything else falls through to its text.
   ponytail: not turndown — images inside links, nested tables and a widget's
   own markup come out as their text. Add turndown when a real gap shows up. */

const BLOCK = /^(P|DIV|UL|OL|LI|H[1-6]|PRE|BLOCKQUOTE|TABLE|THEAD|TBODY|TR|HR)$/;

const cls = (el: Element) => el.getAttribute("class") ?? "";
const elems = (n: Node) => Array.from(n.childNodes).filter((c) => c.nodeType === 1) as Element[];
const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;

/** Children in order, a newline pushed in front of a block that follows text. */
function inner(n: Node, depth: number): string {
  let out = "";
  for (const c of Array.from(n.childNodes)) {
    if (c.nodeType === 1 && BLOCK.test((c as Element).tagName) && out && !out.endsWith("\n")) out += "\n";
    out += fragmentMd(c, depth);
  }
  return out;
}

/** A DOM node (or the fragment a Range hands over) back to markdown. */
export function fragmentMd(n: Node, depth = 0): string {
  if (n.nodeType === 3) return n.textContent ?? "";
  if (n.nodeType === 11) return inner(n, depth);
  if (n.nodeType !== 1) return "";
  const el = n as Element;
  const kids = () => inner(el, depth);
  switch (el.tagName) {
    case "BR": return "\n";
    case "HR": return "---\n\n";
    case "STRONG": case "B": return `**${kids()}**`;
    case "EM": case "I": return `*${kids()}*`;
    case "DEL": case "S": return `~~${kids()}~~`;
    case "CODE": return `\`${kids()}\``;
    case "A": return `[${kids()}](${el.getAttribute("href") ?? ""})`;
    case "IMG": return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
    case "INPUT": return el.getAttribute("checked") === null ? "[ ] " : "[x] ";
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
      return `${"#".repeat(Number(el.tagName[1]))} ${kids().trim()}\n\n`;
    case "P": return `${kids().trim()}\n\n`;
    case "PRE": return fence("", el.textContent ?? "");
    case "BLOCKQUOTE": return `${quote(kids().trim())}\n\n`;
    case "UL": case "OL": {
      const items = elems(el).map((li, i) => {
        const mark = el.tagName === "OL" ? `${i + 1}. ` : "- ";
        return mark + fragmentMd(li, depth + 1).trim().replace(/\n/g, `\n${" ".repeat(mark.length)}`);
      });
      return items.join("\n") + (depth ? "\n" : "\n\n");
    }
    case "TR": return `| ${elems(el).map((c) => fragmentMd(c, depth).trim().replace(/\s*\n\s*/g, " ")).join(" | ")} |\n`;
    case "THEAD": return kids() + `|${" --- |".repeat(elems(elems(el)[0] ?? el).length)}\n`;
    case "TABLE": return `${kids().trim()}\n\n`;
    case "DIV": {
      const c = cls(el);
      if (/md-(code-lang|admonition-label)/.test(c)) return "";
      // The rail's own label: a fence's language, an admonition's kind.
      const tag = elems(el).find((k) => /md-(code-lang|admonition-label)/.test(cls(k)))?.textContent ?? "";
      if (c.includes("md-code")) return fence(tag, elems(el).find((k) => k.tagName === "PRE")?.textContent ?? "");
      if (c.includes("md-admonition")) return `${quote(`[!${tag}]\n${kids().trim()}`)}\n\n`;
      return kids();
    }
    default: return kids();
  }
}

/** What's selected right now, as markdown — null when it isn't inside one
 *  rendered block, where the browser's own copy is the right one. */
export function selectionMd(): string | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const a = range.commonAncestorContainer;
  const el = a.nodeType === 1 ? (a as Element) : a.parentElement;
  if (!el?.closest(".md")) return null;
  // Lines picked out of one code block are those lines, not a fence.
  if (el.closest("pre")) return sel.toString();
  return fragmentMd(range.cloneContents()).replace(/\n{3,}/g, "\n\n").trim();
}
