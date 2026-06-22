import { Wrench, Check, X } from "lucide-react";
import { Button, Card } from "./ui";

export function PermissionCard({
  toolName,
  summary,
  active,
  resolved,
  onAllow,
  onDeny,
}: {
  toolName: string;
  summary?: string;
  active: boolean;
  resolved?: "allow" | "deny";
  onAllow: () => void;
  onDeny: () => void;
}) {
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
          <Button className="flex-1" onClick={onAllow}>
            Allow
          </Button>
          <Button variant="secondary" className="flex-1" onClick={onDeny}>
            Deny
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
          ) : (
            "—"
          )}
        </div>
      )}
    </Card>
  );
}
