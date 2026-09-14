import { cloneElement, isValidElement, memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { selectionMd } from "../lib/selmd";
import { tokenize, type Tok } from "../lib/hl";
import { parseFileRef } from "../lib/filepath";
import { FileIcon } from "../lib/fileicon";
import { widgetLang, widgetValue } from "../lib/widgetblock";
import { collapseProgress, type Progress } from "../lib/progressline";
import type { ToolStyle } from "../lib/toolwidget";
import { BlockWidget, drawWidget } from "./ResultWidgets";

// Renders assistant text as GitHub-flavored Markdown. Styling lives in the
// `.md` block in index.css. Links open in a new tab.
// Memoized: re-parsing every past text block on each poll of a long, streaming
// turn is the single most expensive thing the transcript does.

/** Everything inside a react-markdown node, flattened back to plain text. */
function textOf(n: unknown): string {
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (n && typeof n === "object" && "props" in n)
    return textOf((n as { props: { children?: unknown } }).props.children);
  return "";
}

/** The one control a rendered reply grows: a glyph that puts the thing it sits
 *  on — a link's URL, a quote's text, a fence's code — on the clipboard as it
 *  reads, not as markdown. Selecting and copying still yields the markdown
 *  (selmd); this is the way out when the markdown is the problem: a message
 *  drafted in a quote pastes without its `> `, a URL without its `[label]()`.
 *  Icon-only on purpose — a text label would be selected along with the quote
 *  and leak into that markdown. `text` is a function when the source is the
 *  drawn element itself: a quote copies what it shows, blank lines included. */
function CopyBtn({ text, title }: { text: string | ((btn: HTMLElement) => string); title: string }) {
  const [hit, setHit] = useState(false);
  return (
    <button
      type="button"
      className="md-copy"
      title={title}
      aria-label={title}
      onClick={(e) => {
        const t = typeof text === "function" ? text(e.currentTarget) : text;
        void navigator.clipboard?.writeText(t).then(() => {
          setHit(true);
          setTimeout(() => setHit(false), 1200);
        }).catch(() => {});
      }}
    >
      {hit ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
    </button>
  );
}

/** A fenced block drawn as its own panel: the language named in the header rail,
 *  the code highlighted with the editor's own grammars (unknown language, or a
 *  block too big to parse, just prints). */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [toks, setToks] = useState<Tok[] | null>(null);

  useEffect(() => {
    let live = true;
    setToks(null);
    void tokenize(code, lang).then((t) => {
      if (live) setToks(t);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [code, lang]);

  return (
    <div className="md-code">
      {lang && <div className="md-code-lang">{lang}</div>}
      <CopyBtn title="Copy code" text={code} />
      <pre>
        <code>
          {toks
            ? toks.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : t.text))
            : code}
        </code>
      </pre>
    </div>
  );
}

/** A pasted job log that is mostly a bar redrawing itself, drawn as the bar.
 *  The percentage is the reading, so it gets the track every other utilisation
 *  in the HUD gets; the step headings between runs stay as the text they were. */
function ProgressBlock({ rows }: { rows: (string | Progress)[] }) {
  return (
    <div className="md-code px-2.5 py-2">
      {rows.map((r, i) =>
        typeof r === "string" ? (
          r.trim() && (
            <div key={i} className="text-[length:var(--t95)] tracking-[1.4px] text-muted-2">
              {r}
            </div>
          )
        ) : (
          <div key={i} className="py-1">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[length:var(--t95)] text-muted-2" title={r.label}>
                {r.label}
              </span>
              <b className="text-[length:var(--t95)] font-normal tabular-nums text-muted-2">{r.pct}%</b>
            </div>
            <span
              className="flc-track mt-1 block"
              role="progressbar"
              aria-valuenow={r.pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={r.label || "progress"}
            >
              <i style={{ width: `${r.pct}%` }} />
            </span>
          </div>
        ),
      )}
    </div>
  );
}

/** GitHub-flavoured callouts: `> [!NOTE]` and friends. The model won't produce
 *  them unbidden — ask for them in a prompt or a skill — but our own reports and
 *  plenty of pasted README content do. */
const ADMONITIONS: Record<string, { label: string; color: string }> = {
  note: { label: "NOTE", color: "var(--acc)" },
  tip: { label: "TIP", color: "var(--ok)" },
  important: { label: "IMPORTANT", color: "var(--purple)" },
  warning: { label: "WARNING", color: "var(--warn)" },
  caution: { label: "CAUTION", color: "var(--err)" },
};
const ADMONITION_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*\n?/i;

/** A bold that is really a label: short, one line, ending in a colon. */
const LEAD_RE = /^[^\n]{2,24}:$/;

/** The same tree with the `[!NOTE]` marker cut out of its first text node. The
 *  marker is always the leading text of the leading paragraph, so only the first
 *  branch needs rewriting. */
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

/** Opening a file from prose: the path, the line it named, and where on screen
 *  the link sits (so an ambiguous name can be asked about in place). */
export type OpenFile = (path: string, line?: number, at?: { x: number; y: number }) => void;

/** An inline code span that names a file, drawn as a link into the editor. The
 *  icon is the same filetype icon the file browser uses, so a path reads as a
 *  file at a glance rather than as more monospace. */
function FileRefSpan({
  path, line, label, onOpen,
}: {
  path: string;
  line?: number;
  label: string;
  onOpen: OpenFile;
}) {
  return (
    <button
      type="button"
      // The link's own box is the anchor: a bare filename can name two files,
      // and the picker that asks which one has to open under the word clicked.
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onOpen(path, line, { x: r.left, y: r.bottom + 4 });
      }}
      title={`Open ${path}${line ? ` at line ${line}` : ""}`}
      className="md-fileref"
    >
      <FileIcon name={path} size={13} />
      <code>{label}</code>
    </button>
  );
}

export const Markdown = memo(function Markdown({
  children, className = "", onOpenFile, toolStyle = "stamp",
}: {
  children: string;
  className?: string;
  /** Given, inline code that parses as a repo path becomes a link. */
  onOpenFile?: OpenFile;
  /** The session's output style, for a ```widget:``` block the model typed —
   *  it is a result printed in the reply, so it wears the same material every
   *  other result does. Callers outside a transcript keep the default. */
  toolStyle?: ToolStyle;
}) {
  return (
    <div
      className={`md ${className}`}
      // What you copy out of a rendered reply is its markdown, not the view.
      onCopy={(e) => {
        const md = selectionMd();
        if (md === null) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", md);
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The glyph after a link copies its URL; a footnote's own `#fn1` hop
          // is not a link anyone wants on the clipboard.
          a: ({ node, href, children, ...props }) => (
            <>
              <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>
              {href && !href.startsWith("#") && <CopyBtn title="Copy link" text={href} />}
            </>
          ),
          // A short bold ending in a colon is a lead-in label ("Root cause:",
          // "Fix:"), not emphasis — it gets rank instead of the wash. The bound
          // is what keeps a bold *clause* out: `**72 passed, 1 failed**` has no
          // colon, and a bold sentence is too long. Single line only, and the
          // colon stays in the text so a copied reply reads back the same.
          strong: ({ node, children, ...props }) => (
            <strong
              className={LEAD_RE.test(textOf(children)) ? "md-lead" : undefined}
              {...props}
            >
              {children}
            </strong>
          ),
          // A wide table used to push the whole transcript column sideways.
          // It scrolls in its own box instead — GitHub's rule, and the one the
          // Mini App already had.
          table: ({ node, ...props }) => (
            <div className="md-tablewrap"><table {...props} /></div>
          ),
          blockquote: ({ children }) => {
            const kind = ADMONITION_RE.exec(textOf(children))?.[1]?.toLowerCase();
            const spec = kind ? ADMONITIONS[kind] : undefined;
            // The glyph goes first so it can float at the head of the quote and
            // the first line wraps around it. innerText, not the markdown: a
            // quote is copied as it reads.
            if (!spec) return (
              <blockquote>
                <CopyBtn title="Copy quote" text={(b) => (b.parentElement as HTMLElement).innerText.trim()} />
                {children}
              </blockquote>
            );
            return (
              <div className="md-admonition" style={{ ["--adm" as string]: spec.color }}>
                <div className="md-admonition-label">{spec.label}</div>
                {stripMarker(children) as ReactNode}
              </div>
            );
          },
          code: ({ node, className: cls, children: kids, ...props }) => {
            // Fenced blocks arrive here too (inside `pre`) — those are the `pre`
            // handler's business, and they carry a language class.
            const raw = textOf(kids);
            const ref = onOpenFile && !cls ? parseFileRef(raw) : null;
            if (ref && onOpenFile) return <FileRefSpan {...ref} label={raw} onOpen={onOpenFile} />;
            return <code className={cls} {...props}>{kids}</code>;
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
              if (value !== null) {
                const drawn = <BlockWidget type={wtype} value={value} style={toolStyle} />;
                if (drawWidget(wtype, value)) return drawn;
              }
            }
            // A job's own progress output, which is a bar already — just one
            // drawn in hyphens, forty times over. Drawn once, as a bar.
            const rows = collapseProgress(code);
            if (rows.some((r) => typeof r !== "string")) return <ProgressBlock rows={rows} />;
            return <CodeBlock code={code} lang={lang} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
