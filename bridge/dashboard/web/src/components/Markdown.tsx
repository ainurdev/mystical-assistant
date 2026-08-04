import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokenize, type Tok } from "../lib/hl";

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

export const Markdown = memo(function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
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
