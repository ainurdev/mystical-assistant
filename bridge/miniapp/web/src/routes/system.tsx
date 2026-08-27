import { createRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api } from "../lib/api";
import { ThemeCards } from "../components/ThemePicker";
import { TOOL_STYLES, useToolStyle } from "../lib/toolwidget";

/* SYSTEM — the controls that belong to the app rather than to one chat: the
   palette, and what's left of the Claude limits this phone is spending. */

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
  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.getUsage(),
    refetchInterval: 60000,
  });
  const { data: state } = useQuery({ queryKey: ["state"], queryFn: () => api.getState() });

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13px] tracking-[3px] text-foreground-bright">SYSTEM</span>
        <span className="text-[10px] tracking-wider text-[var(--tg-hint)]">OUTPUT · THEME · LIMITS</span>
      </div>

      <div className="space-y-2">
        <div className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">LIMITS</div>
        {usage?.available ? (
          <div className="space-y-1.5">
            <Bucket label="5 HOUR" bucket={usage.five_hour} />
            <Bucket label="WEEK" bucket={usage.seven_day} />
          </div>
        ) : (
          <div className="text-xs text-[var(--tg-hint)]">Usage unavailable.</div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">OUTPUT STYLE</div>
        <OutputStyleRow />
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

/** The pick itself lives on its own page: four rendered previews do not fit in
 *  a section between LIMITS and THEME, and a list of four words was exactly the
 *  thing that made the styles unreadable. This is the current one, and the way
 *  in. */
function OutputStyleRow() {
  const [style] = useToolStyle();
  const cur = TOOL_STYLES.find((o) => o.key === style) ?? TOOL_STYLES[0];
  return (
    <Link
      to="/output"
      className="flex w-full items-center gap-2.5 bg-[var(--tg-secondary-bg)] px-3 py-2.5 active:opacity-70"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] tracking-[1.5px]">{cur.label}</div>
        <div className="truncate text-[10px] text-[var(--tg-hint)]">{cur.hint}</div>
      </div>
      <ChevronRight size={14} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
    </Link>
  );
}
