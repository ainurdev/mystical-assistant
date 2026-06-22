import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sevColor(sev: string | undefined): string {
  if (sev === "critical" || sev === "exceeded") return "text-red-400";
  if (sev && sev !== "normal") return "text-amber-400";
  return "text-[var(--tg-hint)]";
}

/** Slim Claude-usage line in the composer: `5h 31% · resets 6:49 AM · Wk 52%`. */
export function UsageStrip() {
  const { data } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.getUsage(),
    refetchInterval: 60000,
  });
  if (!data?.available) return null;
  const fh = data.five_hour;
  const sd = data.seven_day;
  if (!fh && !sd) return null;

  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px]">
      {fh && (
        <span className={sevColor(fh.severity)}>
          5h {fh.percent}%
          {fh.resets_at ? ` · resets ${fmtReset(fh.resets_at)}` : ""}
        </span>
      )}
      {fh && sd && <span className="text-[var(--tg-hint)] opacity-40">·</span>}
      {sd && <span className={sevColor(sd.severity)}>Wk {sd.percent}%</span>}
    </div>
  );
}
