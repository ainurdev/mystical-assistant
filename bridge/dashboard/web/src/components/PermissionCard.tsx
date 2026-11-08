import { useEffect, useRef, useState } from "react";
import { Wrench } from "lucide-react";
import { Button, Card, Spinner } from "./ui";
import { Keys } from "./ui/Keys";

// Mirrors bridge/miniapp/web/src/components/PermissionCard.tsx (shared design).
// Live only: answered, it's AskDock's AskRecord; where the box can take it, it docks (AskDock).
export function PermissionCard({
  toolName,
  summary,
  detail,
  onAllow,
  onDeny,
}: {
  toolName: string;
  summary?: string;
  /** The full tool input (MCP calls) — what an Allow actually posts. */
  detail?: string;
  /** Resolve when the answer has reached the bridge; `false` means it didn't. */
  onAllow: () => void | Promise<boolean | void>;
  onDeny: () => void | Promise<boolean | void>;
}) {
  // The card only flips to Allowed/Denied on the next transcript poll — without
  // this the click looks like it did nothing. See QuestionCard.
  const [sending, setSending] = useState<"allow" | "deny" | null>(null);
  async function answer(which: "allow" | "deny", fn: () => void | Promise<boolean | void>) {
    if (sending) return;
    setSending(which);
    if ((await fn()) === false) setSending(null);
  }
  // ⌘1 allows, ⌘2 denies, as a click would — when this is the topmost live
  // Ask card (QuestionCard's `mark`, the same one). The Mini App's twin has no
  // keyboard to serve, so it stays without.
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sending || e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (document.querySelector("[data-ask-keys]") !== mark.current) return;
      if (e.code !== "Digit1" && e.code !== "Digit2") return;
      e.preventDefault();
      if (e.code === "Digit1") void answer("allow", onAllow);
      else void answer("deny", onDeny);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <Card className="chatcard pcard pcard-live space-y-2 border border-[var(--tg-button)]/30">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Wrench
          size={15}
          className="shrink-0 text-[var(--brand-soft)]"
          aria-hidden
        />
        <span>
          Allow <span className="font-semibold">{toolName}</span>?
        </span>
      </div>
      {summary && !detail && (
        <div className="break-all font-mono text-xs text-[var(--tg-hint)]">{summary}</div>
      )}
      {detail && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border border-[var(--tg-button)]/20 p-2 font-mono text-[11px] leading-relaxed text-[var(--tg-hint)]">
          {detail}
        </pre>
      )}
      <div className="flex gap-2">
        <span ref={mark} data-ask-keys hidden />
        <Button className="flex-1" disabled={!!sending} onClick={() => void answer("allow", onAllow)}>
          {sending === "allow" ? <Spinner className="h-3 w-3 border" /> : <>Allow <Keys k="Ctrl+1" hover /></>}
        </Button>
        <Button variant="secondary" className="flex-1" disabled={!!sending} onClick={() => void answer("deny", onDeny)}>
          {sending === "deny" ? <Spinner className="h-3 w-3 border" /> : <>Deny <Keys k="Ctrl+2" hover /></>}
        </Button>
      </div>
    </Card>
  );
}
