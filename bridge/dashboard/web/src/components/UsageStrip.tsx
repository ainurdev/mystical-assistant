import { useEffect, useState } from "react";
import { api, type UsageInfo } from "../api";
import { fmtDuration } from "../lib/surfaces";

const MODE_LABEL: Record<string, string> = {
  default: "ask each time",
  acceptEdits: "accept edits",
  plan: "plan mode",
  bypassPermissions: "bypass perms",
};

function resetsIn(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return fmtDuration((t - Date.now()) / 1000);
}

/** Composer context strip: a 5-hour usage meter (percent remaining), the reset
 *  countdown, and the read-only permission-mode chip. Wired to real /local/usage. */
export function ContextStrip({ permissionMode }: { permissionMode?: string | null }) {
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

  const fh = usage?.available ? usage.five_hour : null;
  const left = fh ? Math.max(0, 100 - fh.percent) : null;
  const reset = resetsIn(fh?.resets_at);
  const modeLabel = permissionMode ? MODE_LABEL[permissionMode] ?? permissionMode : null;

  if (left === null && !modeLabel) return null;

  return (
    <div className="mb-2.5 flex items-center gap-3 px-1 font-mono text-[11.5px]">
      {left !== null && (
        <div className="flex flex-1 items-center gap-2">
          <span className="text-muted-foreground">context</span>
          <div className="h-[5px] max-w-[160px] flex-1 overflow-hidden rounded-[3px] bg-panel-border">
            <div
              className="h-full rounded-[3px] bg-gradient-to-r from-success to-brand-soft"
              style={{ width: `${left}%` }}
            />
          </div>
          <span className="text-[#a99fd0]">{left}% left</span>
        </div>
      )}
      {left !== null && reset && <span className="text-muted-2">·</span>}
      {reset && (
        <span className="text-muted-foreground">
          resets <span className="text-[#a99fd0]">in {reset}</span>
        </span>
      )}
      {modeLabel && <span className="text-muted-2">·</span>}
      {modeLabel && (
        <div className="flex items-center gap-1.5 rounded-[7px] border border-ring/40 bg-[#211a39] px-2.5 py-[3px]">
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          <span className="text-foreground">{modeLabel}</span>
        </div>
      )}
    </div>
  );
}
