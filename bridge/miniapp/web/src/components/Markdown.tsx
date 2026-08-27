import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders assistant text as GitHub-flavored Markdown. Styling lives in the
// `.md` block in index.css. Links open in a new tab.
// Memoized: re-parsing every past text block on each poll of a long, streaming
// turn is the single most expensive thing the transcript does.
export const Markdown = memo(function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
          // Its own scroll box, so a wide table swipes instead of squeezing the
          // rest of the reply into a column of single words.
          table: ({ node, ...props }) => (
            <div className="md-tablewrap"><table {...props} /></div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
