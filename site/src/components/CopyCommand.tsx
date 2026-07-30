import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/** The install block — the page's primary action, so it doubles as the CTA. */
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

  return (
    <div className="panel brackets flex items-stretch gap-2 p-1 pl-3 text-left">
      <pre className="min-w-0 flex-1 overflow-x-auto py-2.5 font-mono text-[0.78rem] leading-relaxed text-[var(--txh)]">
        {command.split("\n").map((line) => (
          <div key={line} className="whitespace-pre">
            <span className="select-none text-[var(--txf)]">$ </span>
            {line}
          </div>
        ))}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied to clipboard" : "Copy install command"}
        className="btn btn-ghost my-1 mr-1 shrink-0 self-center px-3"
      >
        {copied ? (
          <>
            <Check size={14} aria-hidden /> Copied
          </>
        ) : (
          <>
            <Copy size={14} aria-hidden /> Copy
          </>
        )}
      </button>
    </div>
  );
}
