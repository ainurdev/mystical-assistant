import { useEffect, useMemo, useState } from "react";
import { api, type EnrichedSession } from "../api";
import { Skeleton } from "./ui";

function ago(sec: number): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Where a session started, for the surface badge (null = bridge default / unknown).
function originLabel(o?: string | null): string | null {
  return { vscode: "VS Code", terminal: "Terminal", dashboard: "Desktop",
           miniapp: "Phone", bot: "Bot" }[o ?? ""] ?? null;
}

/** Full-width history: one flat list of every session, most-recent first, each
 *  row labeled with the project it belongs to. Clicking a session resumes it
 *  (onOpen switches the active project first). */
export function HistoryView({ onOpen }: { onOpen: (s: EnrichedSession) => void }) {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    const tick = async () => {
      try {
        const h = await api.history(showArchived);
        if (live) {
          setSessions(h.sessions);
          setLoaded(true);
        }
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [showArchived]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (live) setRunning(new Set(r.bridge_running));
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return sessions
      .filter(
        (s) =>
          !q ||
          (s.title ?? "").toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) => b.last_activity - a.last_activity);
  }, [sessions, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter chats & projects…"
          className="w-64 rounded bg-secondary px-2 py-1 outline-none placeholder:text-muted-foreground"
        />
        <label className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Archived
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-4">
        {!loaded ? (
          [0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-1.5 rounded-md border border-border bg-card px-3 py-2">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No chats yet.</div>
        ) : (
          rows.map((s) => (
            <button
              key={s.id}
              onClick={() => onOpen(s)}
              className="flex w-full flex-col gap-0.5 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-accent"
            >
              <div className="flex items-center gap-2">
                {running.has(s.id) && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {s.title || "New chat"}
                  {s.archived ? " (archived)" : ""}
                </span>
                {originLabel(s.origin) && (
                  <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-[var(--brand-soft)]">
                    {originLabel(s.origin)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {/* which project this session belongs to (replaces repo grouping) */}
                <span className="max-w-[45%] truncate font-medium text-[var(--brand-soft)]" title={s.project}>
                  {s.project}
                </span>
                <span className="truncate">
                  · {s.turn_count} {s.turn_count === 1 ? "turn" : "turns"} · $
                  {s.total_cost.toFixed(2)}
                  {s.models.length ? ` · ${s.models.join(", ")}` : ""} · {ago(s.last_activity)}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
