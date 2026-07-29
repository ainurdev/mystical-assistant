import { useState } from "react";
import type { GitBadge, SessionBrief } from "../../api";

export interface ProjectGroup {
  rel: string;
  name: string;
  badge?: GitBadge;
  sessions: SessionBrief[]; // most-recent few, for display (capped)
  sessionCount: number; // true total, for the count label
  running: boolean;
}

interface Props {
  groups: ProjectGroup[];
  activeProject: string | null;
  onSelectProject: (rel: string) => void;
  onAnalyze: (rel: string) => void;
  onPreview: (rel: string) => void;
  onManage: () => void;
  onCreateProject: (name: string, prompt: string) => void;
}

/** Owning folder of a repo path: "ainurhq/efas/app" → "ainurhq/efas",
 *  "aligned" → "" (top level). Shared with the manage modal so both group
 *  projects the same way. */
export function parentOf(rel: string): string {
  const clean = rel.replace(/^\/+|\/+$/g, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? "" : clean.slice(0, i);
}

/** Cluster repos under their full parent folder, so a sub-org gets its own
 * group: "ainurhq/efas/app" clusters under "ainurhq/efas", "ainurhq/invoicer"
 * under "ainurhq". Top-level repos stay their own headerless cluster so the
 * incoming (alphabetical) order is preserved. Cluster position = first member,
 * which keeps every "ainurhq/…" cluster adjacent. */
function clusterByParent(groups: ProjectGroup[]): { parent: string; items: ProjectGroup[] }[] {
  const clusters: { parent: string; items: ProjectGroup[] }[] = [];
  const at = new Map<string, number>();
  for (const g of groups) {
    const parent = parentOf(g.rel);
    const key = parent || `~${g.rel}`;
    const idx = at.get(key);
    if (idx == null) { at.set(key, clusters.length); clusters.push({ parent, items: [g] }); }
    else clusters[idx].items.push(g);
  }
  return clusters;
}

function ProjectRow({
  g, active, onSelectProject, onAnalyze, onPreview,
}: {
  g: ProjectGroup;
  active: boolean;
  onSelectProject: (rel: string) => void;
  onAnalyze: (rel: string) => void;
  onPreview: (rel: string) => void;
}) {
  const [anHov, setAnHov] = useState(false);
  const dirty = g.badge?.dirty ?? 0;
  const dot = g.running ? "var(--ok)" : dirty > 0 ? "var(--warn)" : "var(--txl)";
  return (
    <div
      data-ctx-type="project" data-ctx-id={g.rel} data-ctx-label={g.name}
      style={{
        display: "flex", alignItems: "center", gap: 9, padding: "9px 10px",
        border: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)",
        borderLeft: `2px solid ${active ? "var(--acc)" : "transparent"}`,
        background: active ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "color-mix(in srgb, var(--panel2) 30%, transparent)",
        animation: "mfadeup .4s ease both",
      }}
    >
      <button
        onClick={() => onSelectProject(g.rel)} title="set as active project"
        style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8, padding: 0 }}
      >
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flex: "none" }} />
        <span style={{ flex: 1, minWidth: 0, display: "block" }}>
          <span style={{ display: "block", fontSize: 12.5, color: "var(--txb)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, fontSize: 9, color: "var(--txd)" }}>
            <span style={{ flex: "none" }}>{g.sessionCount} sess</span>
            {g.badge?.branches != null && (
              <span style={{ flex: "none" }}>{g.badge.branches} br · {g.badge.worktrees} wt</span>
            )}
          </span>
        </span>
      </button>
      {g.running && (
        <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)", padding: "1px 5px", flex: "none" }}>LIVE</span>
      )}
      {/* ponytail: preview (eye) button hidden — the preview flow isn't working
          yet. onPreview plumbing kept so re-enabling is just this button back. */}
      <button
        onClick={() => onAnalyze(g.rel)} title="open project details"
        onMouseEnter={() => setAnHov(true)} onMouseLeave={() => setAnHov(false)}
        style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: anHov ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontFamily: "inherit", padding: "5px 7px", flex: "none", display: "flex", alignItems: "center", lineHeight: 0 }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 4h6v6M20 4l-8 8" />
          <path d="M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" />
        </svg>
      </button>
    </div>
  );
}

export function ProjectsPanel(props: Props) {
  const { groups, activeProject, onSelectProject, onAnalyze, onPreview, onManage, onCreateProject } = props;
  const [newOpen, setNewOpen] = useState(false);
  const [npName, setNpName] = useState("");
  const [npPrompt, setNpPrompt] = useState("");
  const [manageHov, setManageHov] = useState(false);
  const [newHov, setNewHov] = useState(false);
  const [createHov, setCreateHov] = useState(false);
  const [cancelHov, setCancelHov] = useState(false);

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", animation: "enterRight .55s cubic-bezier(.2,.8,.2,1) both", flex: "none" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "var(--txl)" }}>PROJECTS</span>
        <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--acc)" }}>{groups.length} REPOS</span>
          <button
            onClick={onManage}
            title="manage projects — hide, remove, import"
            onMouseEnter={() => setManageHov(true)} onMouseLeave={() => setManageHov(false)}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: manageHov ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "color-mix(in srgb, var(--acc) 5%, transparent)", color: manageHov ? "var(--txb)" : "var(--txm)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 8px" }}
          >MANAGE</button>
          <button
            onClick={() => setNewOpen((o) => !o)} title="new project from a prompt"
            onMouseEnter={() => setNewHov(true)} onMouseLeave={() => setNewHov(false)}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--info) 32%, transparent)", background: newHov ? "color-mix(in srgb, var(--info) 16%, transparent)" : "color-mix(in srgb, var(--info) 6%, transparent)", color: "var(--info-hi)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 8px" }}
          >+ NEW</button>
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))", transformOrigin: "left", animation: "drawline .7s ease both" }} />
      <div style={{ padding: "9px 10px 11px", display: "flex", flexDirection: "column", gap: 7 }}>
        {newOpen && (
          <div style={{ border: "1px solid color-mix(in srgb, var(--info) 32%, transparent)", background: "color-mix(in srgb, var(--info) 5%, transparent)", padding: "11px 12px", marginBottom: 10, animation: "mslide .2s ease both" }}>
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--txl)", marginBottom: 9 }}>NEW PROJECT</div>
            <input value={npName} onChange={(e) => setNpName(e.target.value)} placeholder="project-name"
              style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 25%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "6px 9px" }} />
            <textarea value={npPrompt} onChange={(e) => setNpPrompt(e.target.value)} placeholder="starting prompt — what should Claude build first?"
              style={{ width: "100%", boxSizing: "border-box", minHeight: 60, resize: "vertical", marginTop: 8, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: 12, lineHeight: 1.5, padding: "8px 9px" }} />
            <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
              <button
                onClick={() => { if (npName.trim() && npPrompt.trim()) { onCreateProject(npName.trim(), npPrompt.trim()); setNpName(""); setNpPrompt(""); setNewOpen(false); } }}
                onMouseEnter={() => setCreateHov(true)} onMouseLeave={() => setCreateHov(false)}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--info)", background: createHov ? "color-mix(in srgb, var(--info) 24%, transparent)" : "color-mix(in srgb, var(--info) 14%, transparent)", color: "var(--info-b)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <span style={{ color: "var(--info)" }}>▸</span>CREATE & START</button>
              <button
                onClick={() => setNewOpen(false)}
                onMouseEnter={() => setCancelHov(true)} onMouseLeave={() => setCancelHov(false)}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: cancelHov ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "8px 12px" }}>CANCEL</button>
            </div>
          </div>
        )}
        {clusterByParent(groups).map(({ parent, items }) => {
          if (!parent) {
            return items.map((g) => (
              <ProjectRow key={g.rel} g={g} active={g.rel === activeProject}
                onSelectProject={onSelectProject} onAnalyze={onAnalyze} onPreview={onPreview} />
            ));
          }
          // "ainurhq/efas" — an org inside an org. Ancestors stay dim, the owning
          // folder takes the accent, and the block indents another step so its
          // rows read as efas's, not ainurhq's.
          const segs = parent.split("/");
          const sub = segs.length > 1;
          return (
            <div key={parent} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 4, marginLeft: (segs.length - 1) * 12 }}>
              <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--txd)", padding: "2px 2px 0" }}>
                {segs.slice(0, -1).map((s) => (
                  <span key={s} style={{ opacity: 0.45 }}>{s.toUpperCase()} / </span>
                ))}
                <span style={{ color: sub ? "var(--acc)" : "var(--txd)" }}>{segs[segs.length - 1].toUpperCase()} /</span>
              </div>
              {/* stronger indent + rail: only these rows are in the org folder — rows
                  below the group are top-level repos, not members */}
              <div style={{ display: "flex", flexDirection: "column", gap: 7, paddingLeft: 12, borderLeft: `1px solid color-mix(in srgb, var(--acc) ${sub ? 45 : 28}%, transparent)` }}>
                {items.map((g) => (
                  <ProjectRow key={g.rel} g={g} active={g.rel === activeProject}
                    onSelectProject={onSelectProject} onAnalyze={onAnalyze} onPreview={onPreview} />
                ))}
              </div>
            </div>
          );
        })}
        {groups.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--txl)", padding: "10px 4px" }}>No projects with sessions yet.</div>
        )}
      </div>
    </div>
  );
}
