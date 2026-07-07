import { useMemo, useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search, CircleHelp } from "lucide-react";
import { rootRoute } from "./root";
import { api, type EnrichedSession } from "../lib/api";
import { useChat } from "../lib/chat";
import { Skeleton } from "../components/ui";

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

function HistoryPage() {
  const navigate = useNavigate();
  const { openSessionInProject } = useChat();
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const history = useQuery({
    queryKey: ["history", showArchived],
    queryFn: () => api.getHistory(showArchived),
    refetchInterval: 5000,
  });
  const running = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const status = running.data?.status ?? {};

  // One flat list, most-recent first; each row is labeled with its project.
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (history.data?.sessions ?? [])
      .filter(
        (s) =>
          !q ||
          (s.title ?? "").toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) => b.last_activity - a.last_activity);
  }, [history.data, filter]);

  async function open(s: EnrichedSession) {
    await openSessionInProject(s.project, s.id);
    void navigate({ to: "/" });
  }

  return (
    <div className="space-y-4 pb-10">
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg bg-[var(--tg-secondary-bg)] px-2.5 py-1.5">
          <Search size={14} className="text-[var(--tg-hint)]" aria-hidden />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter chats & projects…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--tg-hint)]"
          />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="ml-auto flex items-center gap-1.5 text-[var(--tg-hint)]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Archived
          </label>
        </div>
      </div>

      {history.isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="space-y-1.5 rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)] px-3 py-2"
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">No chats yet.</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((s) => {
            const st = status[s.id]?.state;
            return (
              <button
                key={s.id}
                onClick={() => void open(s)}
                className="flex w-full flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)] px-3 py-2 text-left active:opacity-70"
              >
                <div className="flex items-center gap-2">
                  {st === "awaiting" ? (
                    <CircleHelp
                      size={13}
                      className="shrink-0 text-amber-400 motion-safe:animate-pulse"
                      aria-label="waiting for your answer"
                    />
                  ) : st === "working" ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                  ) : st === "live" ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400/50" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {s.title || "New chat"}
                    {s.archived ? " (archived)" : ""}
                  </span>
                  {originLabel(s.origin) && (
                    <span className="shrink-0 rounded bg-[var(--tg-button)]/15 px-1.5 py-0.5 text-[10px] text-[var(--tg-hint)]">
                      {originLabel(s.origin)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--tg-hint)]">
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
            );
          })}
        </div>
      )}
    </div>
  );
}

export const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryPage,
});
