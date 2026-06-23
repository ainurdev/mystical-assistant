import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CircleHelp } from "lucide-react";
import { api, type ProjectsListing, type RunningSession, type SessionBrief } from "../api";
import { RunningNow } from "./RunningNow";

function ago(sec: number): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function Sidebar({
  projectRel,
  sessions,
  selectedId,
  onSelectSession,
  onNewSession,
  onProjectChanged,
}: {
  projectRel: string | null;
  sessions: SessionBrief[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onProjectChanged: () => void;
}) {
  const [listing, setListing] = useState<ProjectsListing | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [external, setExternal] = useState<RunningSession[]>([]);
  const [bridgeIds, setBridgeIds] = useState<Set<string>>(new Set());
  const [awaiting, setAwaiting] = useState<Map<string, "question" | "permission">>(new Map());
  // Projects the user has expanded; collapsed projects show only their latest chat.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Machine-wide running sessions: powers the panel and the per-session dots.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (!live) return;
        setExternal(r.external);
        setBridgeIds(new Set(r.bridge_running));
        setAwaiting(new Map((r.awaiting ?? []).map((a) => [a.session_id, a.kind])));
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

  async function load(dir: string) {
    try {
      setListing(await api.projects(dir === "/" ? undefined : dir));
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (browsing && !listing) void load("/");
  }, [browsing, listing]);

  async function useFolder() {
    if (!listing) return;
    try {
      await api.select(listing.rel);
      setBrowsing(false);
      onProjectChanged();
    } catch {
      /* ignore */
    }
  }

  function toggle(proj: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(proj) ? next.delete(proj) : next.add(proj);
      return next;
    });
  }

  // Sessions arrive ordered by (project, updated DESC), so each group is latest-first.
  const byProject = new Map<string, SessionBrief[]>();
  for (const s of sessions) {
    const a = byProject.get(s.project) ?? [];
    a.push(s);
    byProject.set(s.project, a);
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="truncate text-sm font-semibold" title={projectRel ?? ""}>
            {projectRel ?? "No project"}
          </div>
          <button
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setBrowsing((v) => !v)}
          >
            {browsing ? "close" : "change"}
          </button>
        </div>
        {browsing && listing && (
          <div className="mb-2 rounded-md border border-border p-2 text-xs">
            <div className="mb-1 font-mono text-muted-foreground">{listing.rel}</div>
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {listing.can_up && (
                <button
                  className="block w-full text-left text-muted-foreground hover:text-foreground"
                  onClick={() => void load(listing.rel.replace(/\/[^/]+$/, "") || "/")}
                >
                  ⬆ ..
                </button>
              )}
              {listing.dirs.map((d) => (
                <button
                  key={d}
                  className="block w-full truncate text-left hover:text-foreground"
                  onClick={() => void load(listing.rel === "/" ? `/${d}` : `${listing.rel}/${d}`)}
                >
                  📁 {d}
                </button>
              ))}
            </div>
            <button
              className="mt-2 w-full rounded bg-primary py-1 text-primary-foreground hover:opacity-90"
              onClick={() => void useFolder()}
            >
              Use {listing.rel}
            </button>
          </div>
        )}
        <button
          className="w-full rounded-md bg-secondary py-1.5 text-xs hover:bg-accent"
          onClick={onNewSession}
        >
          ＋ New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <RunningNow
          external={external}
          bridgeIds={bridgeIds}
          sessions={sessions}
          onSelect={onSelectSession}
        />
        {[...byProject.entries()].map(([proj, ss]) => {
          const open = expanded.has(proj);
          const latest = ss[0];
          const sel = ss.find((s) => s.id === selectedId);
          // Collapsed: show the latest chat (plus the open one, if it's a different chat).
          const shown = open ? ss : sel && sel.id !== latest.id ? [latest, sel] : [latest];
          const hidden = ss.length - shown.length;
          const projAwaiting = ss.some((s) => awaiting.has(s.id));
          const projRunning = ss.some((s) => bridgeIds.has(s.id));
          return (
            <div key={proj} className="mb-2">
              <button
                onClick={() => toggle(proj)}
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                title={proj}
              >
                {open ? (
                  <ChevronDown size={12} className="shrink-0" aria-hidden />
                ) : (
                  <ChevronRight size={12} className="shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-left">{proj}</span>
                {projAwaiting ? (
                  <CircleHelp size={11} className="shrink-0 text-amber-400" aria-label="waiting for you" />
                ) : projRunning ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-label="running" />
                ) : null}
                <span className="shrink-0 tabular-nums opacity-70">{ss.length}</span>
              </button>
              {shown.map((s) => {
                const kind = awaiting.get(s.id);
                const running = bridgeIds.has(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => onSelectSession(s.id)}
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${
                      s.id === selectedId ? "bg-primary/15 text-foreground" : "hover:bg-accent"
                    }`}
                  >
                    <span className="flex w-3.5 shrink-0 justify-center">
                      {kind ? (
                        <CircleHelp
                          size={13}
                          className="text-amber-400 motion-safe:animate-pulse"
                          aria-label="waiting for your answer"
                        />
                      ) : running ? (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse"
                          aria-label="running"
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{s.title || "New chat"}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {ago(s.updated)}
                    </span>
                  </button>
                );
              })}
              {!open && hidden > 0 && (
                <button
                  onClick={() => toggle(proj)}
                  className="px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  +{hidden} more
                </button>
              )}
            </div>
          );
        })}
        {sessions.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground">No sessions yet.</div>
        )}
      </div>
    </aside>
  );
}
