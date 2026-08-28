import { cloneElement, isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { widgetLang, widgetValue } from "../lib/widgetblock";
import type { ToolStyle } from "../lib/toolwidget";
import { BlockWidget, drawWidget } from "./ResultWidgets";

// Renders assistant text as GitHub-flavored Markdown. Styling lives in the
// `.md` block in index.css. Links open in a new tab.
// Memoized: re-parsing every past text block on each poll of a long, streaming
// turn is the single most expensive thing the transcript does.
//
// Mirrors bridge/dashboard/web/src/components/Markdown.tsx. Two things are
// deliberately NOT carried across, because they name something this surface
// does not have rather than something it renders differently:
//   - the file-ref link, which opens the dashboard's editor (there is none here)
//   - syntax highlighting, which would pull the editor's grammars (lib/hl) into
//     a phone bundle to colour a block you mostly scroll past
// A fenced block still gets the same frame and the same language rail, so a
// reply reads as the same reply on both surfaces.

/** Everything inside a react-markdown node, flattened back to plain text. */
function textOf(n: unknown): string {
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (n && typeof n === "object" && "props" in n)
    return textOf((n as { props: { children?: unknown } }).props.children);
  return "";
}

/** GitHub-flavoured callouts: `> [!NOTE]` and friends. */
const ADMONITIONS: Record<string, { label: string; color: string }> = {
  note: { label: "NOTE", color: "var(--acc)" },
  tip: { label: "TIP", color: "var(--ok)" },
  important: { label: "IMPORTANT", color: "var(--purple)" },
  warning: { label: "WARNING", color: "var(--warn)" },
  caution: { label: "CAUTION", color: "var(--err)" },
};
const ADMONITION_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*\n?/i;

/** A bold that is really a label: short, one line, ending in a colon. Mirrors
 *  the dashboard's rule — the same reply has to read the same on both. */
const LEAD_RE = /^[^\n]{2,24}:$/;

/** The same tree with the `[!NOTE]` marker cut out of its first text node. */
function stripMarker(node: unknown): unknown {
  if (typeof node === "string") return node.replace(ADMONITION_RE, "");
  if (Array.isArray(node)) {
    const i = node.findIndex((n) => n !== null && n !== undefined && n !== "");
    return i < 0 ? node : node.map((n, k) => (k === i ? stripMarker(n) : n));
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: unknown };
    if (props.children === undefined) return node;
    return cloneElement(node, undefined, stripMarker(props.children) as ReactNode);
  }
  return node;
}

export const Markdown = memo(function Markdown({ children, className = "", toolStyle = "stamp" }: {
  children: string;
  className?: string;
  /** The session's output style, for a ```widget:``` block the model typed — it
   *  is a result printed in the reply, so it wears the same material every
   *  other result does. Callers outside a transcript keep the default. */
  toolStyle?: ToolStyle;
}) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
          // A short bold ending in a colon is a lead-in label ("Root cause:",
          // "Fix:"), not emphasis — it gets rank instead of the wash. Worth more
          // here than on the desktop: on 390px of glass the labels are most of
          // what you can see while scrolling. The colon stays in the text.
          strong: ({ node, children, ...props }) => (
            <strong
              className={LEAD_RE.test(textOf(children)) ? "md-lead" : undefined}
              {...props}
            >
              {children}
            </strong>
          ),
          // Its own scroll box, so a wide table swipes instead of squeezing the
          // rest of the reply into a column of single words.
          table: ({ node, ...props }) => (
            <div className="md-tablewrap"><table {...props} /></div>
          ),
          blockquote: ({ children }) => {
            const kind = ADMONITION_RE.exec(textOf(children))?.[1]?.toLowerCase();
            const spec = kind ? ADMONITIONS[kind] : undefined;
            if (!spec) return <blockquote>{children}</blockquote>;
            return (
              <div className="md-admonition" style={{ ["--adm" as string]: spec.color }}>
                <div className="md-admonition-label">{spec.label}</div>
                {stripMarker(children) as ReactNode}
              </div>
            );
          },
          pre: ({ children }) => {
            const el = (Array.isArray(children) ? children[0] : children) as
              { props?: { className?: string; children?: unknown } } | undefined;
            // `:` is in the class because a widget fence is written
            // ```widget:table — the tag arrives verbatim from remark.
            const lang = /language-([\w:+-]+)/.exec(el?.props?.className ?? "")?.[1] ?? "";
            const code = textOf(el?.props?.children).replace(/\n$/, "");
            // A typed block the model drew on purpose (lib/widgetblock). Every
            // step here can decline — an unknown type, a body still streaming
            // in, a payload that isn't the shape its type promised — and each
            // declines to the same place: the code block this always drew.
            const wtype = widgetLang(lang);
            if (wtype) {
              const value = widgetValue(code);
              if (value !== null && drawWidget(wtype, value))
                return <BlockWidget type={wtype} value={value} style={toolStyle} />;
            }
            return (
              <div className="md-code">
                {lang && <div className="md-code-lang">{lang}</div>}
                <pre><code>{code}</code></pre>
              </div>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
