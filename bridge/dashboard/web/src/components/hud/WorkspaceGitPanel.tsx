import { api, type GitBadge, type SessionBrief, type SessionStatus } from "../../api";
import { GitTab } from "../GitTab";
import { Panel } from "./Panel";

/** Bottom-of-sidebar workspace control: the project selector on top (switch
 *  between repos that have sessions), with the active project's full git detail
 *  (changes, commit, push) directly below. Replaces the standalone Projects panel
 *  and the right-panel Git tab. */
export function WorkspaceGitPanel({
  sessions,
  gitBadges,
  status,
  activeProject,
  onSelectProject,
  onOpenDiff,
}: {
  sessions: SessionBrief[];
  gitBadges: Map<string, GitBadge>;
  status: Map<string, SessionStatus>;
  activeProject: string | null;
  onSelectProject: () => void;
  onOpenDiff: (path: string) => void;
}) {
  // Distinct repos that have sessions, with whether any is working (bridge or
  // native), from the one unified status map.
  const repos = [...new Set(sessions.map((s) => s.project))].map((name) => ({
    name,
    running: sessions.some((s) => s.project === name && status.get(s.id)?.state === "working"),
    badge: gitBadges.get(name),
  }));

  async function pick(rel: string) {
    if (rel === activeProject) return;
    try {
      await api.select(rel);
      onSelectProject();
    } catch {
      /* ignore */
    }
  }

  return (
    <Panel label="PANEL" title="WORKSPACE // GIT" delay=".24s">
      {/* Project selector */}
      <div className="px-2.5 pb-1 pt-2">
        {repos.map((p, i) => {
          const active = p.name === activeProject;
          const dirty = p.badge?.dirty ?? 0;
          const dot = p.running ? "#8fd9a8" : dirty > 0 ? "#e3c279" : "#3c544f";
          return (
            <div
              key={p.name}
              onClick={() => void pick(p.name)}
              className="mb-1 cursor-pointer border-l-2 px-2.5 py-2 hover:bg-accent"
              style={{
                borderColor: active ? "var(--primary)" : "transparent",
                background: active ? "var(--ac-06)" : "transparent",
                animation: `mfadeup .4s ease both ${i * 50}ms`,
              }}
            >
              <div className="flex items-center gap-2">
                <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: dot }} />
                <span className="flex-1 truncate text-[12.5px] text-foreground-bright">{p.name}</span>
                {p.running && (
                  <span className="border border-[rgba(143,217,168,.3)] px-[5px] py-px text-[9px] tracking-[1px] text-success">
                    LIVE
                  </span>
                )}
              </div>
              {p.badge && (
                <div className="mt-1.5 flex items-center gap-2.5 pl-[15px] text-[10.5px] text-muted-foreground">
                  <span className="text-primary">⎇ {p.badge.branch || "—"}</span>
                  <span className="ml-auto flex gap-2.5">
                    <span style={{ color: dirty > 0 ? "#e3c279" : "#3c544f" }}>●{dirty}</span>
                    <span>↑{p.badge.ahead}</span>
                    <span>↓{p.badge.behind}</span>
                  </span>
                </div>
              )}
            </div>
          );
        })}
        {repos.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-muted-2">NO PROJECTS</div>
        )}
      </div>

      {/* Active project's git detail (changes / commit / push), moved here from
          the right-panel tab. */}
      <div className="mx-2.5 border-t border-dashed border-border" />
      <GitTab project={activeProject} onOpenDiff={onOpenDiff} />
    </Panel>
  );
}
