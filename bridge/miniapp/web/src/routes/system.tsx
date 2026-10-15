import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api } from "../lib/api";
import { useSpentUsage } from "../lib/accounts";
import { useChat } from "../lib/chat";
import { ThemeCards } from "../components/ThemePicker";
import { useFoldsOpen } from "../lib/folds";

/* SYSTEM — the controls that belong to the app rather than to one chat: the
   palette, and what's left of the Claude limits this phone is spending — the
   login the open chat runs on, which a profile pick or a fallback handover
   changes. */

function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sevColor(sev: string | undefined): string {
  if (sev === "critical" || sev === "exceeded") return "text-red-400";
  if (sev && sev !== "normal") return "text-amber-400";
  return "text-[var(--brand-soft)]";
}

function Bucket({
  label,
  bucket,
}: {
  label: string;
  bucket: { percent: number; resets_at: string | null; severity: string } | null | undefined;
}) {
  if (!bucket) return null;
  return (
    <div className="border border-border bg-[var(--tg-secondary-bg)] px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] tracking-[1.5px] text-[var(--tg-hint)]">{label}</span>
        <span className={`ml-auto text-sm ${sevColor(bucket.severity)}`}>{bucket.percent}%</span>
      </div>
      <div className="mt-1.5 h-1 w-full bg-[var(--ac-06)]">
        <div
          className="h-1 bg-[var(--brand-soft)]"
          style={{ width: `${Math.min(100, Math.max(0, bucket.percent))}%` }}
        />
      </div>
      {bucket.resets_at && (
        <div className="mt-1.5 text-[10px] tracking-wider text-[var(--muted-2)]">
          RESETS {fmtReset(bucket.resets_at).toUpperCase()}
        </div>
      )}
    </div>
  );
}

function SystemPage() {
  const { sessionSlot } = useChat();
  const { usage, tag, who } = useSpentUsage(sessionSlot);
  const { data: state } = useQuery({ queryKey: ["state"], queryFn: () => api.getState() });

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13px] tracking-[3px] text-foreground-bright">SYSTEM</span>
        <span className="text-[10px] tracking-wider text-[var(--tg-hint)]">THEME · LIMITS</span>
      </div>

      <div className="space-y-2">
        <div className="flex min-w-0 items-baseline gap-2 text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">
          LIMITS
          {tag && (
            <span className="truncate tracking-wider text-[var(--tg-hint)]">
              {[tag, who].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        {usage?.available ? (
          <div className="space-y-1.5">
            <Bucket label="5 HOUR" bucket={usage.five_hour} />
            <Bucket label="WEEK" bucket={usage.seven_day} />
          </div>
        ) : (
          <div className="text-xs text-[var(--tg-hint)]">
            {sessionSlot === null ? "This chat runs on another agent: no Claude limits." : "Usage unavailable."}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">TRANSCRIPT</div>
        <FoldsRow />
      </div>

      <div className="space-y-2">
        <div className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">THEME</div>
        <ThemeCards />
      </div>

      <div className="space-y-1 text-[10px] tracking-wider text-[var(--muted-2)]">
        <div>PROJECT · {(state?.project?.rel ?? "none").toUpperCase()}</div>
        <div>MODE · {(state?.permission_mode ?? "default").toUpperCase()}</div>
      </div>
    </div>
  );
}

export const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: SystemPage,
});

/** Between two things the agent says or thinks, its steps sit under one row.
 *  On (the default) that row mounts shut, so the words are what you see; off,
 *  it mounts open and a turn reads as the whole ledger. A tap on any one row
 *  still moves only that row. Thoughts are never folded (lib/segments). */
function FoldsRow() {
  const [open, setOpen] = useFoldsOpen();
  const on = !open;
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-pressed={on}
      className="flex w-full items-center gap-2.5 bg-[var(--tg-secondary-bg)] px-3 py-2.5 text-left active:opacity-70"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] tracking-[1.5px]">COLLAPSE STEPS</div>
        <div className="text-[10px] leading-snug text-[var(--tg-hint)]">
          {on ? "The work sits under one row until you open it." : "Every step mounts open."}
        </div>
      </div>
      <span
        className="flex flex-none border p-[2px] text-[9px] tracking-[1px]"
        style={{ borderColor: "color-mix(in srgb, var(--acc) 25%, transparent)" }}
        aria-hidden
      >
        <span className="px-2 py-[3px]" style={{ background: on ? "var(--acc)" : "transparent", color: on ? "var(--acc-on)" : "var(--muted-2)" }}>ON</span>
        <span className="px-2 py-[3px]" style={{ background: on ? "transparent" : "var(--ac-12)", color: on ? "var(--muted-2)" : "var(--foreground-bright)" }}>OFF</span>
      </span>
    </button>
  );
}
