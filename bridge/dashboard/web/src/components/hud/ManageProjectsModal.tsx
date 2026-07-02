import { useState } from "react";
import { projectTint } from "../../lib/surfaces";
import type { ProjectGroup } from "./ProjectsPanel";

/* MANAGE PROJECTS modal — matches the HUD design mock (hud.dc.html lines
   1283–1318): project rows (dot, name, tag, HIDDEN badge, sess count,
   HIDE/SHOW + REMOVE) and the import-existing-repository row. */

interface Props {
  groups: ProjectGroup[]; // manageable projects (removed ones filtered out; hidden included)
  imported: string[];     // locally imported repo paths — TODO(phase2-data): no bridge endpoint yet
  hidden: Record<string, boolean>;
  onToggleHide: (rel: string) => void;
  onRemove: (rel: string) => void;
  onImport: (path: string) => void;
  onClose: () => void;
}

function basename(rel: string): string {
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

export function ManageProjectsModal(props: Props) {
  const { groups, imported, hidden, onToggleHide, onRemove, onImport, onClose } = props;
  const [importPath, setImportPath] = useState("");
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const rows = [
    ...groups.map((g) => {
      const dirty = g.badge?.dirty ?? 0;
      return {
        rel: g.rel, name: g.name,
        dot: g.running ? "#8fd9a8" : dirty > 0 ? "#e3c279" : "#3c544f",
        sessionCount: g.sessionCount,
      };
    }),
    // Imported-but-sessionless repos still show here so they can be managed.
    ...imported
      .filter((rel) => !groups.some((g) => g.rel === rel))
      .map((rel) => ({ rel, name: basename(rel), dot: "#3c544f", sessionCount: 0 })),
  ];

  const doImport = () => {
    const raw = importPath.trim();
    if (!raw) return;
    onImport(raw);
    setImportPath("");
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(4,7,7,.74)", zIndex: 94, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "9vh", animation: "backdropIn .2s ease both" }}>
      <div onClick={(e) => e.stopPropagation()} className="panel"
        style={{ width: 580, maxWidth: "94vw", maxHeight: "80vh", display: "flex", flexDirection: "column", border: "1px solid rgba(127,233,216,.4)", background: "rgba(7,13,13,.98)", boxShadow: "0 0 60px rgba(0,0,0,.8)", animation: "mslide .2s ease both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 18px", borderBottom: "1px solid rgba(127,233,216,.16)", flex: "none" }}>
          <span style={{ fontSize: 9.5, letterSpacing: 2.5, color: "#3c544f" }}>MANAGE</span>
          <span style={{ fontSize: 15, color: "#dff8f2", letterSpacing: ".5px" }}>Projects</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} {...hp("esc")}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: hov === "esc" ? "rgba(127,233,216,.08)" : "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: "6px 12px" }}>ESC ✕</button>
        </div>
        <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 18px" }}>
          <div style={{ fontSize: 9, letterSpacing: 1.5, color: "#3c544f", marginBottom: 9 }}>HIDE keeps a project out of the sidebar · REMOVE detaches it from the bridge</div>
          <div style={{ border: "1px solid rgba(127,233,216,.12)" }}>
            {rows.map((r) => {
              const tint = projectTint(r.rel);
              const isHidden = !!hidden[r.rel];
              return (
                <div key={r.rel}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderBottom: "1px solid rgba(127,233,216,.07)", opacity: isHidden ? 0.5 : 1 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: r.dot, flex: "none" }} />
                  <span style={{ fontSize: 12.5, color: "#dff8f2", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  <span style={{ fontSize: 8.5, letterSpacing: ".5px", color: tint.color, border: `1px solid ${tint.border}`, padding: "0 5px", flex: "none" }}>{tint.tag}</span>
                  {isHidden && (
                    <span style={{ fontSize: 8, letterSpacing: 1, color: "#6f938d", border: "1px solid rgba(127,233,216,.18)", padding: "1px 5px", flex: "none" }}>HIDDEN</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 9, color: "#6f938d", flex: "none" }}>{r.sessionCount} sess</span>
                  <button onClick={() => onToggleHide(r.rel)} title="hide / show in sidebar" {...hp(`hide:${r.rel}`)}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: hov === `hide:${r.rel}` ? "rgba(127,233,216,.1)" : "transparent", color: "#bfe6de", fontFamily: "inherit", fontSize: 8.5, letterSpacing: 1, padding: "5px 10px", flex: "none" }}>{isHidden ? "SHOW" : "HIDE"}</button>
                  <button onClick={() => onRemove(r.rel)} title="remove project" {...hp(`rm:${r.rel}`)}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(224,137,122,.28)", background: hov === `rm:${r.rel}` ? "rgba(224,137,122,.12)" : "transparent", color: hov === `rm:${r.rel}` ? "#e0897a" : "#9a6f68", fontFamily: "inherit", fontSize: 8.5, letterSpacing: 1, padding: "5px 9px", flex: "none" }}>REMOVE</button>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 9, letterSpacing: 1.5, color: "#3c544f", margin: "18px 0 9px" }}>IMPORT EXISTING REPOSITORY</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid rgba(111,181,255,.3)", background: "rgba(111,181,255,.05)", padding: "9px 11px" }}>
            <span style={{ fontSize: 12, color: "#6fb5ff", flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>⌂</span>
            <input value={importPath} onChange={(e) => setImportPath(e.target.value)}
              placeholder="/home/squared/dev/my-repo"
              style={{ flex: 1, minWidth: 0, background: "rgba(7,13,13,.6)", border: "1px solid rgba(111,181,255,.22)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, padding: "7px 9px" }} />
            <button onClick={doImport} {...hp("import")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid #6fb5ff", background: hov === "import" ? "rgba(111,181,255,.24)" : "rgba(111,181,255,.14)", color: "#dbeeff", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: "8px 13px", flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#6fb5ff" }}>▸</span>IMPORT</button>
          </div>
        </div>
      </div>
    </div>
  );
}
