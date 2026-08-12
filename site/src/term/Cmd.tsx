import { useEffect, useState } from "react";

/**
 * The install block, which is the page's one primary action.
 *
 * Stacks below `sm`: side by side on a phone the button sits over the command
 * and clips it mid-URL with nothing to say it scrolls.
 */
export function Cmd({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // Blocked on insecure origins and in some embedded views. The command is
      // selectable text either way, so failing quietly is the right failure.
    }
  }

  const lines = command.split("\n");

  return (
    <div className="win">
      <div className="win-bar">
        <span className="font-mono text-[0.66rem] tracking-[0.06em] text-[var(--ink-dim)]">
          <span className="text-[var(--ink-ghost)]">▸ </span>bash
        </span>
        <span className="tag st-live">Ready</span>
      </div>

      <div className="flex flex-col items-stretch gap-1 p-1 pl-3 sm:flex-row sm:gap-2">
        {/* Wraps rather than scrolls. The clone line is 57 characters and a
            390px viewport cannot hold it at a readable size, and a horizontally
            scrolling command just hides the back half of the URL with nothing
            to say it is there. At the 38rem desktop measure it never wraps. */}
        <pre className="min-w-0 flex-1 py-2.5 font-mono text-[0.68rem] leading-relaxed break-all whitespace-pre-wrap text-[var(--ink)] sm:text-[0.76rem]">
          {lines.map((line, i) => (
            <div key={line}>
              <span className="select-none text-[var(--ink-ghost)]">$ </span>
              {line}
              {i === lines.length - 1 && <span className="caret" aria-hidden />}
            </div>
          ))}
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied to clipboard" : "Copy install command"}
          className="btn btn-primary m-1 shrink-0 sm:my-1 sm:self-center"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
