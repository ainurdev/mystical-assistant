import { useState } from "react";
import { Button, Card } from "./ui";
import type { HudCard } from "../lib/api";

// Mirrors bridge/dashboard/web/src/components/FlowCard.tsx (shared design), the
// way QuestionCard already does. A typed turn's settled result: what it did,
// the fields its stage owes, and the moves you can take from here — so the
// answer is a thing you act on rather than a wall to read.
export function FlowCard({
  card,
  gated,
  isCurrent,
  onAction,
  onApprove,
}: {
  card: HudCard;
  /** The stage this card belongs to holds a gate. */
  gated: boolean;
  /** The session is still standing on that stage (an older card is history). */
  isCurrent: boolean;
  onAction: (send: string) => void;
  onApprove: () => void;
}) {
  // The prompt only comes back on the next poll, so an untouched-looking button
  // reads as dropped and gets pressed twice (same reason QuestionCard tracks it).
  const [sent, setSent] = useState<string | null>(null);
  const fields = Object.entries(card.fields ?? {});
  const awaitingApproval = gated && card.advance === true && isCurrent;

  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] tracking-[0.15em] text-muted-foreground">
          {card.stage.toUpperCase()}
        </span>
        <span className="text-sm">{card.summary}</span>
      </div>

      {fields.length > 0 && (
        <dl className="space-y-1">
          {fields.map(([name, value]) => (
            <div key={name} className="flex gap-2 text-xs">
              <dt className="shrink-0 tracking-[0.1em] text-muted-foreground">
                {name.toUpperCase()}
              </dt>
              <dd className="min-w-0 break-words">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {(awaitingApproval || (card.actions?.length ?? 0) > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {awaitingApproval && (
            <Button size="sm" onClick={onApprove}>
              APPROVE ▸
            </Button>
          )}
          {(card.actions ?? []).slice(0, 3).map((a) => (
            <Button
              key={a.label}
              size="sm"
              variant="outline"
              disabled={sent === a.label}
              onClick={() => {
                setSent(a.label);
                onAction(a.send);
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

// Fields are whatever the stage asked for — a list of files, a verdict, a count.
function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
