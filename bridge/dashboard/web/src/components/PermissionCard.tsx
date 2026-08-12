import { useState } from "react";
import { Wrench, Check, X, CircleSlash } from "lucide-react";
import { Button, Card, Spinner } from "./ui";

// Mirrors bridge/miniapp/web/src/components/PermissionCard.tsx (shared design).
export function PermissionCard({
  toolName,
  summary,
  active,
  resolved,
  stale,
  onAllow,
  onDeny,
}: {
  toolName: string;
  summary?: string;
  active: boolean;
  resolved?: "allow" | "deny";
  /** Asked, never answered, and the run has since ended — the process that would
   *  receive the answer is gone, so the buttons would do nothing. */
  stale?: boolean;
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
  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
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
      {summary && (
        <div className="break-all font-mono text-xs text-[var(--tg-hint)]">{summary}</div>
      )}
      {active ? (
        <div className="flex gap-2">
          <Button className="flex-1" disabled={!!sending} onClick={() => void answer("allow", onAllow)}>
            {sending === "allow" ? <Spinner className="h-3 w-3 border" /> : "Allow"}
          </Button>
          <Button variant="secondary" className="flex-1" disabled={!!sending} onClick={() => void answer("deny", onDeny)}>
            {sending === "deny" ? <Spinner className="h-3 w-3 border" /> : "Deny"}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-[var(--tg-hint)]">
          {resolved === "allow" ? (
            <>
              <Check size={13} className="text-green-400" aria-hidden /> Allowed
            </>
          ) : resolved === "deny" ? (
            <>
              <X size={13} className="text-red-400" aria-hidden /> Denied
            </>
          ) : stale ? (
            <>
              <CircleSlash size={13} className="text-[var(--warn)]" aria-hidden /> Never
              answered — the run ended
            </>
          ) : (
            "—"
          )}
        </div>
      )}
    </Card>
  );
}
