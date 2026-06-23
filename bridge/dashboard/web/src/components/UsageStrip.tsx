import { useEffect, useState } from "react";
import { api, type UsageInfo } from "../api";

function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sevColor(sev: string | undefined): string {
  if (sev === "critical" || sev === "exceeded") return "text-red-400";
  if (sev && sev !== "normal") return "text-amber-400";
  return "text-muted-foreground";
}

/** Slim Claude-usage line above the composer: `5h 31% · resets 6:49 AM · Wk 52%`. */
export function UsageStrip() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const u = await api.usage();
        if (live) setUsage(u);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 60000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (!usage?.available) return null;
  const fh = usage.five_hour;
  const sd = usage.seven_day;
  if (!fh && !sd) return null;

  return (
    <div className="mb-2 flex items-center gap-1.5 text-[11px]">
      {fh && (
        <span className={sevColor(fh.severity)}>
          5h {fh.percent}%{fh.resets_at ? ` · resets ${fmtReset(fh.resets_at)}` : ""}
        </span>
      )}
      {fh && sd && <span className="text-muted-foreground">·</span>}
      {sd && <span className={sevColor(sd.severity)}>Wk {sd.percent}%</span>}
    </div>
  );
}
