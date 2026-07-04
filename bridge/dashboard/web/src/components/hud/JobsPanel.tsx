import type { RunningJob } from "../../api";
import { ago } from "../../lib/surfaces";
import { Panel } from "./Panel";

/** Live monitor for this machine's background Claude runs (streaming bridge
 *  jobs): what each is doing right now, with tap-to-open. */
export function JobsPanel({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: RunningJob[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Panel label="LIVE" title="BACKGROUND JOBS" delay=".1s">
      <div className="px-2.5 pb-2.5 pt-2">
        {jobs.map((j, i) => {
          const awaiting = j.activity.state === "awaiting";
          const color = awaiting ? "var(--warn)" : "var(--ok)";
          return (
            <div
              key={j.job_id}
              onClick={() => j.session_id && onSelect(j.session_id)}
              className="flex cursor-pointer items-center gap-[9px] px-2 py-2 hover:bg-accent"
              style={{
                animation: `mfadeup .4s ease both ${i * 50}ms`,
                background: j.session_id && j.session_id === selectedId ? "var(--ac-06)" : undefined,
              }}
            >
              <span className="relative flex h-2 w-2 flex-none">
                {!awaiting && (
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                    style={{ background: color }}
                  />
                )}
                <span className="inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-[var(--txh)]">{j.title || "new session"}</div>
                <div className="mt-0.5 truncate text-[9.5px] tracking-[.5px] text-muted-2">
                  {j.project || "—"} · {j.activity.label}
                </div>
              </div>
              <div className="flex flex-none flex-col items-end gap-0.5">
                <span className="text-[9px] tracking-[1px]" style={{ color }}>
                  {awaiting ? "WAIT" : "RUN"}
                </span>
                <span className="text-[9px] text-muted-2">{ago(j.started)}</span>
              </div>
            </div>
          );
        })}
        {jobs.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-muted-2">NO BACKGROUND JOBS</div>
        )}
      </div>
    </Panel>
  );
}
