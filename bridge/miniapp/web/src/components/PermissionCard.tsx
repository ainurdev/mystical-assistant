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
      <div className="text-sm font-medium">
        🔧 Allow <span className="font-semibold">{toolName}</span>?
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
        <div className="text-xs text-[var(--tg-hint)]">
          {resolved === "allow" ? "✓ Allowed" : resolved === "deny" ? "✕ Denied" : "—"}
        </div>
      )}
    </Card>
  );
}
