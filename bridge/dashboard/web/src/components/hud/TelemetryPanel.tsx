import type { Telemetry } from "../../lib/telemetry";
import { avg, poly } from "../../lib/telemetry";
import { Panel } from "./Panel";

export function TelemetryPanel({
  tele,
  turns,
  tools,
  cost,
  errors,
}: {
  tele: Telemetry;
  turns: number;
  tools: number;
  cost: number;
  errors: number;
}) {
  const stat = (k: string, v: string, color = "text-foreground") => (
    <div>
      <div className="text-[9px] tracking-[1px] text-muted-2">{k}</div>
      <div className={`mt-[3px] text-[13px] ${color}`}>{v}</div>
    </div>
  );
  return (
    <Panel label="PANEL" title="AGENT TELEMETRY" delay=".08s">
      <div className="px-3.5 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] tracking-[1.5px] text-muted-foreground">AGENT ACTIVITY</span>
          <span className="text-[10px] tracking-[1px] text-muted-2">
            AVG <span className="text-primary">{avg(tele.sparkA)}%</span>
          </span>
        </div>
        <svg viewBox="0 0 320 42" preserveAspectRatio="none" className="mt-[5px] h-[42px] w-full overflow-visible">
          <line x1="0" y1="21" x2="320" y2="21" className="stroke-border" strokeWidth="1" />
          <polyline points={poly(tele.sparkA, 320, 42, 4)} fill="none" className="stroke-primary" strokeWidth="1.4" />
        </svg>

        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-[10px] tracking-[1.5px] text-muted-foreground">TOOL THROUGHPUT</span>
          <span className="text-[10px] tracking-[1px] text-muted-2">
            AVG <span className="text-violet">{avg(tele.sparkB)}%</span>
          </span>
        </div>
        <svg viewBox="0 0 320 42" preserveAspectRatio="none" className="mt-[5px] h-[42px] w-full overflow-visible">
          <line x1="0" y1="21" x2="320" y2="21" className="stroke-border" strokeWidth="1" />
          <polyline points={poly(tele.sparkB, 320, 42, 4)} fill="none" stroke="#b9a6ff" strokeWidth="1.4" />
        </svg>

        <div className="mt-3.5 grid grid-cols-4 gap-2 border-t border-dashed border-border pt-3">
          {stat("TURNS", String(turns))}
          {stat("TOOLS", String(tools).padStart(2, "0"))}
          {stat("COST", `$${cost.toFixed(2)}`)}
          {stat("ERRORS", String(errors).padStart(2, "0"), errors > 0 ? "text-danger" : "text-success")}
        </div>
      </div>
    </Panel>
  );
}
