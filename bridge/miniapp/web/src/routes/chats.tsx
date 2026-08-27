import { useMemo, useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search, CircleHelp } from "lucide-react";
import { rootRoute } from "./root";
import { api, needsYou, type EnrichedSession } from "../lib/api";
import { useChat } from "../lib/chat";
import { Skeleton } from "../components/ui";
import { SurfaceBadge } from "../components/SurfaceBadge";

/* CHATS — every session on this machine, whatever started it, waiting ones
   first. This is the tab you open to find the conversation you left running. */

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

type Tab = "all" | "waiting" | "running" | "archived";

/** Wall clock and tokens replaced the dollar figure here in 9f612a4 — the CLI
 *  prices runs off API list rates while these go through a subscription. */
function dur(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function tok(n: number): string {
  return n < 1000 ? `${n} tok` : n < 1_000_000 ? `${(n / 1000).toFixed(0)}k tok` : `${(n / 1_000_000).toFixed(1)}M tok`;
}

function ChatsPage() {
  const navigate = useNavigate();
  const { openSessionInProject } = useChat();
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<Tab>("all");

  const history = useQuery({
    queryKey: ["history", tab === "archived"],
    queryFn: () => api.getHistory(tab === "archived"),
    refetchInterval: 5000,
  });
  const running = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const status = running.data?.status ?? {};

  const all = history.data?.sessions ?? [];
  const waiting = all.filter((s) => needsYou(status[s.id]?.state)).length;
  const live = all.filter((s) => {
    const st = status[s.id]?.state;
    return st === "working" || st === "live" || st === "checking";
  }).length;

  // Waiting first, then live, then most recent — the same order the switcher uses.
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rank = (s: EnrichedSession) => {
      const st = status[s.id]?.state;
      return st === "awaiting" ? 0 : st === "asking" ? 1
        : st === "working" || st === "checking" ? 2 : st === "live" ? 3 : 4;
    };
    return all
      .filter((s) => {
        if (q && !(s.title ?? "").toLowerCase().includes(q) && !s.project.toLowerCase().includes(q))
          return false;
        const st = status[s.id]?.state;
        if (tab === "waiting") return needsYou(st);
        if (tab === "running") return st === "working" || st === "checking" || st === "live";
        return true;
      })
      .slice()
      .sort((a, b) => rank(a) - rank(b) || b.last_activity - a.last_activity);
  }, [all, status, filter, tab]);

  async function open(s: EnrichedSession) {
    await openSessionInProject(s.project, s.id);
    void navigate({ to: "/" });
  }

  const TABS: { id: Tab; label: string; tone?: "warn" }[] = [
    { id: "all", label: "ALL" },
    { id: "waiting", label: `WAITING · ${waiting}`, tone: "warn" },
    { id: "running", label: "RUNNING" },
    { id: "archived", label: "ARCHIVED" },
  ];

  return (
    <div className="space-y-3 pb-6">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13px] tracking-[3px] text-foreground-bright">CHATS</span>
        <span className="text-[10px] tracking-wider text-[var(--tg-hint)]">
          EVERY MACHINE SESSION
        </span>
        <span className="ml-auto text-[10px] tracking-wider">
          {waiting > 0 && <span className="text-amber-400">{waiting} WAITING</span>}
          <span className="text-[var(--tg-hint)]">
            {waiting > 0 ? " · " : ""}
            {live} LIVE
          </span>
        </span>
      </div>

      <div className="flex items-center gap-2 border border-border bg-[var(--tg-secondary-bg)] px-3 py-2">
        <Search size={14} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter chats & projects…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--tg-hint)]"
        />
      </div>

      <div className="flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`border px-2.5 py-1.5 text-[10px] tracking-[1.5px] active:opacity-70 ${
              tab === t.id
                ? "border-border-bright bg-[var(--ac-06)] text-foreground-bright"
                : `border-border ${t.tone === "warn" ? "text-amber-400" : "text-[var(--tg-hint)]"}`
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {history.isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-1.5 border border-border bg-[var(--tg-secondary-bg)] px-3 py-2.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">No chats here.</div>
      ) : (
        // Every session in the store, uncapped — off-screen cards skip layout/paint.
        <div className="vskip-card space-y-1.5">
          {rows.map((s) => {
            const st = status[s.id]?.state;
            const isWaiting = needsYou(st);
            return (
              <button
                key={s.id}
                onClick={() => void open(s)}
                className={`flex w-full flex-col gap-1 border px-3 py-2.5 text-left active:opacity-70 ${
                  isWaiting
                    ? "border-amber-400/40 border-l-2 border-l-amber-400 bg-[var(--card)]"
                    : "border-border bg-[var(--tg-secondary-bg)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  {isWaiting ? (
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
                  {/* No kind-of-work chip: a session runs many flows over its
                      life (one per prompt), so a tag would just be its last. */}
                  <SurfaceBadge origin={s.origin} />
                </div>
                <div className="flex gap-1.5 text-[11px] text-[var(--tg-hint)]">
                  <span className="max-w-[45%] truncate font-medium text-[var(--brand-soft)]" title={s.project}>
                    {s.project}
                  </span>
                  <span className="truncate">
                    · {s.turn_count} {s.turn_count === 1 ? "turn" : "turns"}
                    {s.total_elapsed > 0 ? ` · ${dur(s.total_elapsed)}` : ""}
                    {s.total_tokens ? ` · ${tok(s.total_tokens)}` : ""} ·{" "}
                    {isWaiting ? "needs an answer" : st === "working" ? "running" : ago(s.last_activity)}
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

export const chatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chats",
  component: ChatsPage,
});
