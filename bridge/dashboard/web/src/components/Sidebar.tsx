import { useEffect, useState } from "react";
import { api, type ProjectsListing, type RunningSession, type SessionBrief } from "../api";
import { RunningNow } from "./RunningNow";

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

  // Machine-wide running sessions: powers the panel and the per-session dots.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (!live) return;
        setExternal(r.external);
        setBridgeIds(new Set(r.bridge_running));
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
        {[...byProject.entries()].map(([proj, ss]) => (
          <div key={proj} className="mb-3">
            <div className="px-1 py-1 text-[11px] uppercase tracking-wide text-muted-foreground" title={proj}>
              {proj}
            </div>
            {ss.map((s) => (
              <button
                key={s.id}
                onClick={() => onSelectSession(s.id)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${
                  s.id === selectedId ? "bg-primary/15 text-foreground" : "hover:bg-accent"
                }`}
              >
                {bridgeIds.has(s.id) && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                    aria-label="running"
                  />
                )}
                <span className="truncate">{s.title || "New chat"}</span>
              </button>
            ))}
          </div>
        ))}
        {sessions.length === 0 && <div className="p-3 text-xs text-muted-foreground">No sessions yet.</div>}
      </div>
    </aside>
  );
}
