import { GraduationCap, Check, X } from "lucide-react";
import { Button, Card } from "./ui";

export function ReviewCandidateCard({
  title,
  whyItMatters,
  snippet,
  active,
  resolved,
  onKeep,
  onSkip,
}: {
  title: string;
  whyItMatters?: string;
  snippet?: string;
  active: boolean;
  resolved?: "kept" | "skipped";
  onKeep: () => void;
  onSkip: () => void;
}) {
  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <GraduationCap size={15} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
        <span>
          Review later: <span className="font-semibold">{title}</span>?
        </span>
      </div>
      {whyItMatters && (
        <div className="text-xs text-[var(--tg-hint)]">{whyItMatters}</div>
      )}
      {snippet && (
        <pre className="overflow-x-auto rounded bg-black/20 p-2 font-mono text-xs text-[var(--tg-hint)]">
          {snippet}
        </pre>
      )}
      {active ? (
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onKeep}>
            Keep
          </Button>
          <Button variant="secondary" className="flex-1" onClick={onSkip}>
            Skip
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-[var(--tg-hint)]">
          {resolved === "kept" ? (
            <>
              <Check size={13} className="text-green-400" aria-hidden /> Kept
            </>
          ) : resolved === "skipped" ? (
            <>
              <X size={13} className="text-red-400" aria-hidden /> Skipped
            </>
          ) : (
            "—"
          )}
        </div>
      )}
    </Card>
  );
}
