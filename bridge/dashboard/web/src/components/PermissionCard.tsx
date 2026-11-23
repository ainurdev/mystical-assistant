import { useState } from "react";
import { Wrench } from "lucide-react";
import { Button, Card, Spinner } from "./ui";
import { Keys, useAskKeys } from "./ui/Keys";
import { SCOPE_WORD, type AllowScope } from "../api";

// Mirrors bridge/miniapp/web/src/components/PermissionCard.tsx (shared design).
// Most live permissions dock on the prompt box instead (AskDock's PermissionDock):
// this card is live only where App's askDocked is false. Answered, it's AskDock's AskRecord.
export function PermissionCard({
  toolName,
  summary,
  detail,
  scopes,
  onAllow,
  onAllowScope,
  onDeny,
}: {
  toolName: string;
  summary?: string;
  /** The full tool input (MCP calls) — what an Allow actually posts. */
  detail?: string;
  /** Resolve when the answer has reached the bridge; `false` means it didn't. */
  onAllow: () => void | Promise<boolean | void>;
  /** How far an Allow may reach past this call, and the click for each. */
  scopes?: AllowScope[];
  onAllowScope?: (scope: AllowScope) => void | Promise<boolean | void>;
  onDeny: () => void | Promise<boolean | void>;
}) {
  // The card only flips to Allowed/Denied on the next transcript poll — without
  // this the click looks like it did nothing. See QuestionCard.
  const [sending, setSending] = useState<"allow" | "deny" | AllowScope | null>(null);
  async function answer(which: "allow" | "deny" | AllowScope, fn: () => void | Promise<boolean | void>) {
    if (sending) return;
    setSending(which);
    if ((await fn()) === false) setSending(null);
  }
  // ⌘1 allows, ⌘2 denies, as a click would, when this is the live Ask on top
  // (ui/Keys). The Mini App's twin has no keyboard to serve, so it stays without.
  const mark = useAskKeys((k) => {
    if (sending || (k !== "1" && k !== "2")) return false;
    void (k === "1" ? answer("allow", onAllow) : answer("deny", onDeny));
    return true;
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
      <div className="flex flex-wrap gap-2">
        <span ref={mark} data-ask-keys hidden />
        <Button className="flex-1" disabled={!!sending} onClick={() => void answer("allow", onAllow)}>
          {sending === "allow" ? <Spinner className="h-3 w-3 border" /> : <>Allow <Keys k="Ctrl+1" hover /></>}
        </Button>
        {onAllowScope && (scopes ?? []).map((sc) => (
          <Button key={sc} variant="secondary" className="flex-1" disabled={!!sending} onClick={() => void answer(sc, () => onAllowScope(sc))}>
            {sending === sc ? <Spinner className="h-3 w-3 border" /> : SCOPE_WORD[sc]}
          </Button>
        ))}
        <Button variant="secondary" className="flex-1" disabled={!!sending} onClick={() => void answer("deny", onDeny)}>
          {sending === "deny" ? <Spinner className="h-3 w-3 border" /> : <>Deny <Keys k="Ctrl+2" hover /></>}
        </Button>
      </div>
    </Card>
  );
}
