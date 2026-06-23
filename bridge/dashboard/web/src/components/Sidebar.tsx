import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api, type GitBadge, type ProjectsListing, type RunningSession, type SessionBrief } from "../api";
import { ago, surfaceFor, type Surface } from "../lib/surfaces";

export function Sidebar({
  projectRel,
  sessions,
  selectedId,
  onSelectSession,
  onNewSession,
  onProjectChanged,
  external,
  bridgeIds,
  awaiting,
  gitBadges,
  browsing,
  onBrowsingChange,
}: {
  projectRel: string | null;
  sessions: SessionBrief[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onProjectChanged: () => void;
  external: RunningSession[];
  bridgeIds: Set<string>;
  awaiting: Map<string, "question" | "permission">;
  gitBadges: Map<string, GitBadge>;
  browsing: boolean;
  onBrowsingChange: (v: boolean) => void;
}) {
  const [listing, setListing] = useState<ProjectsListing | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleProject(proj: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(proj)) next.delete(proj);
      else next.add(proj);
      return next;
    });
  }

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
      onBrowsingChange(false);
      onProjectChanged();
    } catch {
      /* ignore */
    }
  }

  // Sessions arrive ordered by (project, updated DESC) — each group is latest-first.
  const byProject = new Map<string, SessionBrief[]>();
  for (const s of sessions) {
    const a = byProject.get(s.project) ?? [];
    a.push(s);
    byProject.set(s.project, a);
  }

  // Active sessions: bridge runs (clickable) + external (read-only).
  const bridgeRows = sessions.filter((s) => bridgeIds.has(s.id));

  // External sessions: running, waiting, or idle — but drop anything inactive for
  // more than 30 min (last_active is the file-mtime activity signal).
  const now = Date.now() / 1000;
  const activeExternal = external.filter((r) => {
    const t = r.last_active ?? r.started;
    return t == null || now - t <= 30 * 60;
  });

  return (
    <aside className="flex h-full w-[312px] shrink-0 flex-col border-r border-panel-border bg-panel">
      <div className="relative shrink-0 p-3.5 pb-2.5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            onClick={() => onBrowsingChange(!browsing)}
            className="flex min-w-0 items-center gap-2"
            title={projectRel ?? ""}
          >
            <span className="truncate font-mono text-[13px] font-medium text-foreground">
              /{projectRel ?? "no project"}
            </span>
            <ChevronDown size={12} className="shrink-0 text-muted-2" aria-hidden />
          </button>
          <button
            onClick={() => onBrowsingChange(!browsing)}
            className="shrink-0 text-xs text-brand-soft hover:text-foreground"
          >
            {browsing ? "close" : "change"}
          </button>
        </div>

        {browsing && listing && (
          <div className="mb-2 rounded-md border border-border bg-popover p-2 text-xs animate-[mpop_.14s_ease]">
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
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-2 rounded-[9px] border border-border bg-popover py-2.5 text-[13px] font-medium text-foreground hover:border-ring"
        >
          <span className="text-base leading-none text-brand-soft">+</span> New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        {(bridgeRows.length > 0 || activeExternal.length > 0) && (
          <>
            <SectionLabel pulse>Active sessions</SectionLabel>
            {bridgeRows.map((s) => {
              const kind = awaiting.get(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  className="mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left hover:bg-accent"
                >
                  <SurfaceTag surf={surfaceFor(s.origin)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-foreground">
                      {s.title || "New chat"}
                    </span>
                    <span className="block font-mono text-[10.5px] text-muted-2">
                      this machine · {ago(s.updated)}
                    </span>
                  </span>
                  <StatusTag
                    color={kind ? "var(--warning)" : "var(--success)"}
                    label={kind ? "waiting" : "running"}
                  />
                </button>
              );
            })}
            {activeExternal.map((r) => {
              const st = externalStatus(r);
              return (
                <div
                  key={r.session_id}
                  title={r.cwd}
                  className="mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left"
                >
                  <SurfaceTag surf={surfaceFor(r.source)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-foreground">{r.project}</span>
                    <span className="block font-mono text-[10.5px] text-muted-2">
                      {r.source} · {ago(r.last_active ?? r.started)}
                    </span>
                  </span>
                  <StatusTag color={st.color} label={st.label} />
                </div>
              );
            })}
          </>
        )}

        <SectionLabel>Recent chats</SectionLabel>
        {[...byProject.entries()].map(([proj, ss]) => {
          const isOpen = expanded.has(proj);
          // Always show: latest (index 0), anything running/waiting, and the selected one.
          const pinned = ss.filter(
            (s, i) =>
              i === 0 || bridgeIds.has(s.id) || awaiting.has(s.id) || s.id === selectedId,
          );
          const visible = isOpen ? ss : pinned;
          const hidden = ss.length - pinned.length;
          return (
          <div key={proj} className="mb-2.5">
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={proj}>
                /{proj}
              </span>
              <span className="shrink-0 rounded-[5px] bg-popover px-1.5 text-[10px] text-muted-2">
                {ss.length}
              </span>
            </div>
            {(() => {
              const b = gitBadges.get(proj);
              if (!b) return null;
              return (
                <div className="mb-1 flex items-center gap-2.5 px-1.5 font-mono text-[11px]">
                  <span className="flex items-center gap-1 text-[#a99fd0]">
                    <span className="text-muted-2">⎇</span>
                    {b.branch}
                  </span>
                  <span className="flex items-center gap-2 text-muted-2">
                    <span
                      title="changed files"
                      style={{ color: b.dirty > 0 ? "var(--warning)" : "var(--muted-2)" }}
                    >
                      ●{b.dirty}
                    </span>
                    <span title="ahead">↑{b.ahead}</span>
                    <span title="behind">↓{b.behind}</span>
                  </span>
                </div>
              );
            })()}
            {visible.map((s) => {
              const on = s.id === selectedId;
              const running = bridgeIds.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left ${
                    on ? "border-ring bg-[#1c162c]" : "border-transparent hover:bg-accent"
                  }`}
                >
                  {running && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                  )}
                  <span
                    className={`min-w-0 flex-1 truncate text-[12.5px] ${
                      on ? "text-foreground" : "text-card-foreground"
                    }`}
                  >
                    {s.title || "New chat"}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-2">
                    {ago(s.updated)}
                  </span>
                </button>
              );
            })}
            {hidden > 0 && (
              <button
                onClick={() => toggleProject(proj)}
                className="mb-1 w-full px-2.5 py-1 text-left font-mono text-[10.5px] text-muted-2 hover:text-foreground"
              >
                {isOpen ? "show less" : `show ${hidden} more`}
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

function SectionLabel({ children, pulse }: { children: React.ReactNode; pulse?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-1.5 pb-2 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted-2">
      {children}
      {pulse && <span className="h-1.5 w-1.5 rounded-full bg-success animate-[mpulse_2.2s_infinite]" />}
    </div>
  );
}

function SurfaceTag({ surf }: { surf: Surface }) {
  return (
    <span
      className="flex w-6 shrink-0 justify-center rounded-[5px] py-[3px] text-center font-mono text-[9.5px] font-medium tracking-wide"
      style={{ color: surf.color, background: surf.bg }}
    >
      {surf.code}
    </span>
  );
}

// Running (turn in flight) / waiting (blocked on you) / idle (alive but quiet).
// status/waiting_for only exist for terminal CLI sessions; VS Code is idle.
function externalStatus(r: RunningSession): { label: string; color: string } {
  if (r.status === "waiting" || r.waiting_for)
    return { label: "waiting", color: "var(--warning)" };
  if (r.status === "running") return { label: "running", color: "var(--success)" };
  return { label: "idle", color: "var(--muted-2)" };
}

function StatusTag({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: color }} />
      <span className="text-[10px]" style={{ color }}>
        {label}
      </span>
    </span>
  );
}
