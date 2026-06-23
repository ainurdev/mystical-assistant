import { api, type GitBadge, type SessionBrief } from "../../api";
import { Panel } from "./Panel";

export function ProjectsPanel({
  sessions,
  gitBadges,
  bridgeIds,
  activeProject,
  onSelectProject,
}: {
  sessions: SessionBrief[];
  gitBadges: Map<string, GitBadge>;
  bridgeIds: Set<string>;
  activeProject: string | null;
  onSelectProject: () => void;
}) {
  // Distinct repos that have sessions, with whether any is running.
  const repos = [...new Set(sessions.map((s) => s.project))].map((name) => ({
    name,
    running: sessions.some((s) => s.project === name && bridgeIds.has(s.id)),
    badge: gitBadges.get(name),
  }));

  async function pick(rel: string) {
    try {
      await api.select(rel);
      onSelectProject();
    } catch {
      /* ignore */
    }
  }

  return (
    <Panel label="PANEL" title="PROJECTS // GIT" delay=".24s">
      <div className="px-2.5 pb-3 pt-2">
        {repos.map((p, i) => {
          const active = p.name === activeProject;
          const dirty = p.badge?.dirty ?? 0;
          const dot = p.running ? "#8fd9a8" : dirty > 0 ? "#e3c279" : "#3c544f";
          return (
            <div
              key={p.name}
              onClick={() => void pick(p.name)}
              className="mb-1 cursor-pointer border-l-2 px-2.5 py-2.5 hover:bg-accent"
              style={{
                borderColor: active ? "#7fe9d8" : "transparent",
                background: active ? "rgba(127,233,216,.06)" : "transparent",
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
    </Panel>
  );
}
