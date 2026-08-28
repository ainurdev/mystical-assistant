import { SplitSquareHorizontal } from "lucide-react";
import { Button, Card } from "./ui";

// Mirrors bridge/dashboard/web/src/components/SuggestNewSessionCard.tsx (shared design).
// The relevance guardrail held a prompt that looks like different work from the
// session it would resume. The prompt is still client-side — nothing ran, nothing
// was stored — until one of these buttons is pressed.
export function SuggestNewSessionCard({
  currentTitle, reason, suggestedTitle, busy, onStartNew, onContinue, onDismiss,
}: {
  currentTitle: string;
  reason: string;
  suggestedTitle: string | null;
  busy?: boolean;
  onStartNew: () => void;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  return (
    <Card className="chatcard space-y-2 border border-[var(--brand-soft)]/30">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <SplitSquareHorizontal size={15} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
        <span>Different work?</span>
      </div>
      <div className="text-sm">
        This looks unrelated to{" "}
        <span className="font-semibold">{currentTitle || "this session"}</span>
        {reason ? ` — ${reason}` : "."}
      </div>
      <div className="flex flex-col gap-2">
        <Button disabled={busy} onClick={onStartNew}>
          {suggestedTitle ? `Start new session · ${suggestedTitle}` : "Start new session"}
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={onContinue}>
            Continue here anyway
          </Button>
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Card>
  );
}
