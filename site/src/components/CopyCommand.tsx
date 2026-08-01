import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/** The install block — the page's one primary action, so it doubles as the CTA. */
export function CopyCommand({ command }: { command: string }) {
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
      // Clipboard is blocked on insecure origins and in some embedded views.
      // The command is selectable text either way, so failing quietly is fine.
    }
  }

  // Stacks below `sm`: side by side on a phone, the button sits on top of the
  // command and clips it mid-URL with no affordance that it scrolls.
  return (
    <div className="frame frame-accent flex flex-col items-stretch gap-1 p-1 pl-3.5 text-left sm:flex-row sm:gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto py-3 font-mono text-[0.76rem] leading-relaxed text-[var(--ink)]">
        {command.split("\n").map((line) => (
          <div key={line} className="whitespace-pre">
            <span className="select-none text-[var(--ink-faint)]">$ </span>
            {line}
          </div>
        ))}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied to clipboard" : "Copy install command"}
        className="btn btn-primary mr-1 mb-1 shrink-0 justify-center sm:my-1 sm:mb-0 sm:self-center"
      >
        {copied ? (
          <>
            <Check size={14} aria-hidden /> COPIED
          </>
        ) : (
          <>
            <Copy size={14} aria-hidden /> COPY
          </>
        )}
      </button>
    </div>
  );
}
