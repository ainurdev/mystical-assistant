import { useRef, useState } from "react";
import { projectName, projectTint } from "../../lib/surfaces";
import { parentOf, type ProjectGroup } from "./ProjectsPanel";

/* The PROJECTS tab of SETTINGS — project rows (dot, name, HIDDEN badge, sess
   count, HIDE/SHOW + REMOVE) and the import-existing-repository row, from the
   HUD design mock (hud.dc.html lines 1283–1318). It was a modal of its own,
   reached from SYSTEM ▸ MANAGE ▸ OPEN: a settings screen two clicks and one
   dialog deep from settings, which is where nobody found it. */

export interface ProjectsSettingsProps {
  groups: ProjectGroup[]; // manageable projects (removed ones filtered out; hidden included)
  imported: string[];     // locally imported repo paths — TODO(phase2-data): no bridge endpoint yet
  hidden: Record<string, boolean>;
  remotes: Record<string, string>; // rel -> owner/repo of origin (GitHub only)
  onSetHidden: (rels: string[], hidden: boolean) => void; // one row, or a whole org
  onRemove: (rel: string) => void;
  onRename: (rel: string, name: string) => void; // blank restores the directory name
  onImport: (path: string) => void;
}

function basename(rel: string): string {
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

export function ProjectsSettings(props: ProjectsSettingsProps) {
  const { groups, imported, hidden, remotes, onSetHidden, onRemove, onRename, onImport } = props;
  const [importPath, setImportPath] = useState("");
  const [hov, setHov] = useState("");
  // Rename in place: the name chip becomes an input. Esc has to blur (not just
  // unmount) or the blur that follows would save what you were escaping from.
  const [editing, setEditing] = useState<{ rel: string; value: string } | null>(null);
  const cancelled = useRef(false);
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const rows = [
    ...groups.map((g) => {
      const dirty = g.badge?.dirty ?? 0;
      return {
        rel: g.rel, name: g.name,
        dot: g.running ? "var(--ok)" : dirty > 0 ? "var(--warn)" : "var(--txl)",
        sessionCount: g.sessionCount,
      };
    }),
    // Imported-but-sessionless repos still show here so they can be managed.
    ...imported
      .filter((rel) => !groups.some((g) => g.rel === rel))
      .map((rel) => ({ rel, name: projectName(rel), dot: "var(--txl)", sessionCount: 0 })),
  ].sort((a, b) => a.rel.localeCompare(b.rel));

  // One section per owning folder — "ainurhq", then "ainurhq/efas" — so a whole
  // org or sub-org can be shown/hidden in one click. Top-level repos share the
  // "~" section. Section position = first member, keeping an org's sub-orgs next
  // to it.
  const sections: { parent: string; rows: typeof rows }[] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const parent = parentOf(r.rel);
    const i = at.get(parent);
    if (i == null) { at.set(parent, sections.length); sections.push({ parent, rows: [r] }); }
    else sections[i].rows.push(r);
  }

  const doImport = () => {
    const raw = importPath.trim();
    if (!raw) return;
    onImport(raw);
    setImportPath("");
  };

  return (
    <>
      <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", marginBottom: 9 }}>CLICK A NAME TO RENAME · THE SLUG IS WHERE ITS origin PUSHES · HIDE keeps a project out of the sidebar · REMOVE detaches it</div>
          {sections.map(({ parent, rows: srows }) => {
            const segs = parent ? parent.split("/") : [];
            const allHidden = srows.every((r) => hidden[r.rel]);
            const hiddenCount = srows.filter((r) => hidden[r.rel]).length;
            return (
          <div key={parent || "~"} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 6px" }}>
              <span style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txd)" }}>
                {segs.length === 0 ? "~ /" : (
                  <>
                    {segs.slice(0, -1).map((s) => <span key={s} style={{ opacity: 0.45 }}>{s.toUpperCase()} / </span>)}
                    <span style={{ color: segs.length > 1 ? "var(--acc)" : "var(--txd)" }}>{segs[segs.length - 1].toUpperCase()} /</span>
                  </>
                )}
              </span>
              <span style={{ fontSize: "var(--t85)", color: "var(--txd)", opacity: 0.7 }}>
                {srows.length} repo{srows.length === 1 ? "" : "s"}{hiddenCount ? ` · ${hiddenCount} hidden` : ""}
              </span>
              <span style={{ flex: 1 }} />
              <button onClick={() => onSetHidden(srows.map((r) => r.rel), !allHidden)}
                title={allHidden ? "show every repo in this org" : "hide every repo in this org"} {...hp(`org:${parent}`)}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === `org:${parent}` ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t8)", letterSpacing: 1, padding: "3px 8px", flex: "none" }}>
                {allHidden ? "SHOW ALL" : "HIDE ALL"}</button>
            </div>
          <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)" }}>
            {srows.map((r) => {
              const tint = projectTint(r.rel);
              const isHidden = !!hidden[r.rel];
              return (
                <div key={r.rel}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 7%, transparent)", opacity: isHidden ? 0.5 : 1 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: r.dot, flex: "none" }} />
                  {editing?.rel === r.rel ? (
                    <input autoFocus value={editing.value} placeholder={basename(r.rel)}
                      onChange={(e) => setEditing({ rel: r.rel, value: e.target.value })}
                      onBlur={() => {
                        if (!cancelled.current) onRename(r.rel, editing.value);
                        cancelled.current = false;
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
                      }}
                      style={{ fontSize: "var(--t85)", letterSpacing: ".5px", color: tint.color, border: `1px solid ${tint.border}`, padding: "0 5px", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", outline: "none", fontFamily: "inherit", width: 160, flex: "none" }} />
                  ) : (
                    <span onClick={() => setEditing({ rel: r.rel, value: r.name })}
                      title={`${r.rel} — click to rename (display only)`}
                      style={{ fontSize: "var(--t85)", letterSpacing: ".5px", color: tint.color, border: `1px solid ${tint.border}`, padding: "0 5px", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "text" }}>{r.name}</span>
                  )}
                  {isHidden && (
                    <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txd)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", padding: "1px 5px", flex: "none" }}>HIDDEN</span>
                  )}
                  <span style={{ flex: 1 }} />
                  {remotes[r.rel] && (
                    <a href={`https://github.com/${remotes[r.rel]}`} target="_blank" rel="noreferrer"
                      title={`origin — github.com/${remotes[r.rel]}`} {...hp(`gh:${r.rel}`)}
                      style={{ fontSize: "var(--t85)", letterSpacing: ".5px", color: hov === `gh:${r.rel}` ? "var(--acc)" : "var(--txd)", textDecoration: "none", flex: "none", whiteSpace: "nowrap" }}>
                      {remotes[r.rel]}</a>
                  )}
                  <span style={{ fontSize: "var(--t9)", color: "var(--txd)", flex: "none" }}>{r.sessionCount} sess</span>
                  <button onClick={() => onSetHidden([r.rel], !isHidden)} title="hide / show in sidebar" {...hp(`hide:${r.rel}`)}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === `hide:${r.rel}` ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, padding: "5px 10px", flex: "none" }}>{isHidden ? "SHOW" : "HIDE"}</button>
                  <button onClick={() => onRemove(r.rel)} title="remove project" {...hp(`rm:${r.rel}`)}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 28%, transparent)", background: hov === `rm:${r.rel}` ? "color-mix(in srgb, var(--err) 12%, transparent)" : "transparent", color: hov === `rm:${r.rel}` ? "var(--err)" : "var(--err-g)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, padding: "5px 9px", flex: "none" }}>REMOVE</button>
                </div>
              );
            })}
          </div>
          </div>
            );
          })}
          <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", marginTop: 18, marginBottom: 9 }}>IMPORT EXISTING REPOSITORY</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)", background: "color-mix(in srgb, var(--info) 5%, transparent)", padding: "9px 11px" }}>
            <span style={{ fontSize: "var(--t12)", color: "var(--info)", flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>⌂</span>
            <input value={importPath} onChange={(e) => setImportPath(e.target.value)}
              placeholder="/home/squared/dev/my-repo"
              style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 22%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "7px 9px" }} />
            <button onClick={doImport} {...hp("import")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--info)", background: hov === "import" ? "color-mix(in srgb, var(--info) 24%, transparent)" : "color-mix(in srgb, var(--info) 14%, transparent)", color: "var(--info-b)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "8px 13px", flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--info)" }}>▸</span>IMPORT</button>
      </div>
    </>
  );
}
