import type { RunningSession, RunningSource, SessionBrief } from "../api";

function ago(sec: number | null): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function icon(source: RunningSource): string {
  if (source === "vscode") return "🟦";
  if (source === "sdk" || source === "bridge") return "🤖";
  return "▷";
}

/** Machine-wide "Running now": this chat's live bridge runs (clickable) then
 *  read-only external sessions (VS Code / terminal). Presentational; the
 *  running data is owned by the Sidebar so the badge dots share one poll. */
export function RunningNow({
  external,
  bridgeIds,
  sessions,
  onSelect,
}: {
  external: RunningSession[];
  bridgeIds: Set<string>;
  sessions: SessionBrief[];
  onSelect: (id: string) => void;
}) {
  const bridgeRows = sessions.filter((s) => bridgeIds.has(s.id));
  if (external.length === 0 && bridgeRows.length === 0) return null;

  return (
    <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium text-zinc-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </span>
        Running now · this machine
      </div>
      <div className="space-y-0.5">
        {bridgeRows.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-zinc-800"
          >
            <span aria-hidden>🤖</span>
            <span className="min-w-0 flex-1 truncate">{s.title || "New chat"}</span>
            <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
              bridge
            </span>
          </button>
        ))}
        {external.map((r) => (
          <div
            key={r.session_id}
            className="flex items-center gap-2 rounded px-2 py-1 text-xs text-zinc-300"
            title={r.cwd}
          >
            <span aria-hidden>{icon(r.source)}</span>
            <span className="min-w-0 flex-1 truncate">{r.project}</span>
            <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
              {r.source}
            </span>
            {r.status === "waiting" ? (
              <span className="shrink-0 text-[10px] text-amber-400">waiting</span>
            ) : (
              <span className="shrink-0 text-[10px] text-zinc-500">{ago(r.started)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
