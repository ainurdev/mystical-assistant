import { useEffect, useMemo, useState } from "react";
import { api, type UsageInfo } from "../../api";
import { Panel } from "./Panel";

const CELLS = 132;

function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "NOW";
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}H ${m % 60}M`;
}

export function ContextMatrixPanel({ permissionMode }: { permissionMode?: string | null }) {
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
  const pct = fh ? fh.percent : 0;
  const used = fh ? Math.round((fh.percent / 100) * 200) : 0;
  const onCells = Math.round((pct / 100) * CELLS);

  const cells = useMemo(
    () =>
      Array.from({ length: CELLS }, (_, i) => ({
        on: i < onCells,
        delay: `${(((i * 37) % 30) / 10).toFixed(1)}s`,
      })),
    [onCells],
  );

  return (
    <Panel label="CONTEXT" title={fh ? `${pct}% · ${used}K / 200K` : "CONTEXT"} delay=".16s">
      <div className="px-3.5 py-3">
        <div className="flex flex-wrap gap-[3px]">
          {cells.map((c, i) => (
            <span
              key={i}
              className="h-[7px] w-[7px]"
              style={{
                background: c.on ? "var(--primary)" : "var(--border)",
                animation: "twinkle 3s ease-in-out infinite",
                animationDelay: c.delay,
              }}
            />
          ))}
        </div>
        <div className="mt-2.5 flex justify-between text-[9.5px] tracking-[1px] text-muted-2">
          <span>
            RESETS IN <span className="text-primary">{fmtReset(fh?.resets_at)}</span>
          </span>
          {permissionMode && (
            <span>
              MODE <span className="text-warning">{permissionMode.toUpperCase()}</span>
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}
