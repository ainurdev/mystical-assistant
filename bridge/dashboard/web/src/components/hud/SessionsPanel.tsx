import type { RunningSession, SessionBrief, SessionStatus } from "../../api";
import { ago, liveSurfaceFor } from "../../lib/surfaces";
import { wavePoly, type Telemetry } from "../../lib/telemetry";
import { Panel } from "./Panel";

export function SessionsPanel({
  sessions,
  status,
  external,
  selectedId,
  onSelect,
  tele,
}: {
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  external: RunningSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  tele: Telemetry;
}) {
  // "Active" = used in the last 30 min and non-empty (has a title), plus anything
  // currently working/live/awaiting regardless of age. Status is the one unified
  // map, so a live VS Code (native) session shows RUN/LIVE here too.
  const now = Date.now() / 1000;
  const RECENT = 30 * 60;
  // Where each session is alive right now (vscode | cli | sdk) — drives the
  // "last prompt from" label, preferred over where the session started.
  const liveSource = new Map(external.map((r) => [r.session_id, r.source]));
  const rows = sessions
    .filter((s) => {
      const live = status.has(s.id);
      const recent = !!s.updated && now - s.updated <= RECENT;
      return live || (!!s.title && recent);
    })
    .slice(0, 8)
    .map((s) => {
      const st = status.get(s.id);
      const label =
        st?.state === "awaiting" ? "WAIT"
        : st?.state === "working" ? "RUN"
        : st?.state === "live" ? "LIVE"
        : "IDLE";
      const color =
        st?.state === "awaiting" ? "#e3c279"
        : st?.state === "working" ? "#8fd9a8"
        : st?.state === "live" ? "#6a9e84"
        : "#3c544f";
      return { s, status: label, color, surf: liveSurfaceFor(s.origin, liveSource.get(s.id)) };
    });

  return (
    <Panel label="PANEL" title="ACTIVE SESSIONS" delay=".12s">
      <div className="px-2.5 pb-1.5 pt-2">
        {rows.map(({ s, status, color, surf }, i) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className="flex cursor-pointer items-center gap-[9px] px-2 py-2 hover:bg-accent"
            style={{
              animation: `mfadeup .4s ease both ${i * 50}ms`,
              background: s.id === selectedId ? "var(--ac-06)" : undefined,
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-[#cfe9e3]">{s.title || "new session"}</div>
              <div className="mt-0.5 text-[9.5px] tracking-[.5px] text-muted-2">
                <span style={{ color: surf.color }}>{surf.label}</span> · {ago(s.updated)}
              </div>
            </div>
            <span className="flex flex-none items-center gap-[5px]">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
              <span className="text-[9px] tracking-[1px]" style={{ color }}>{status}</span>
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-muted-2">NO ACTIVE SESSIONS · 30M</div>
        )}
      </div>
      <div className="px-3.5 pb-3 pt-1">
        <div className="flex items-baseline justify-between border-t border-dashed border-border pt-3">
          <span className="text-[10px] tracking-[1.5px] text-muted-foreground">CONVERSATION I/O</span>
          <span className="text-[9.5px] text-muted-2">SHARED STORE · SYNC</span>
        </div>
        <svg viewBox="0 0 340 60" preserveAspectRatio="none" className="mt-1.5 h-[58px] w-full overflow-visible">
          <line x1="0" y1="12" x2="340" y2="12" className="stroke-border" strokeWidth="1" />
          <line x1="0" y1="30" x2="340" y2="30" className="stroke-border" strokeWidth="1" />
          <line x1="0" y1="48" x2="340" y2="48" className="stroke-border" strokeWidth="1" />
          <polyline points={wavePoly(tele.wave, 340, 60)} fill="none" className="stroke-primary" strokeWidth="1.3" />
        </svg>
      </div>
    </Panel>
  );
}
