import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokenize, type Tok } from "../lib/hl";
import { parseFileRef } from "../lib/filepath";
import { FileIcon } from "../lib/fileicon";

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

/** An inline code span that names a file, drawn as a link into the editor. The
 *  icon is the same filetype icon the file browser uses, so a path reads as a
 *  file at a glance rather than as more monospace. */
function FileRefSpan({
  path, line, label, onOpen,
}: {
  path: string;
  line?: number;
  label: string;
  onOpen: (path: string, line?: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(path, line)}
      title={`Open ${path}${line ? ` at line ${line}` : ""}`}
      className="md-fileref"
    >
      <FileIcon name={path} size={11} />
      <code>{label}</code>
    </button>
  );
}

export const Markdown = memo(function Markdown({
  children, className = "", onOpenFile,
}: {
  children: string;
  className?: string;
  /** Given, inline code that parses as a repo path becomes a link. */
  onOpenFile?: (path: string, line?: number) => void;
}) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
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
            const lang = /language-([\w+-]+)/.exec(el?.props?.className ?? "")?.[1] ?? "";
            return <CodeBlock code={textOf(el?.props?.children).replace(/\n$/, "")} lang={lang} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
