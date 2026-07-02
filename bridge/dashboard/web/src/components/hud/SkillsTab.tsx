import { useEffect, useState } from "react";
import { api } from "../../api";

/* SKILLS tab of the Analyze modal — monorepo-aware skill browser. Matches the
   HUD design mock (hud.dc.html lines 1121–1235). There is no skills backend
   yet: the scope list is the repository root, SCAN wires to the closest real
   call (run-command/stack detection), and suggested/installed/catalog render
   their realistic empty states.
   TODO(phase2-data): skills endpoints (scopes, scan, suggest, install, catalog). */

interface Props {
  project: string;
  name: string;
}

export function SkillsTab({ project, name }: Props) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [scan, setScan] = useState<"idle" | "scanning" | "done">("idle");
  const [detected, setDetected] = useState("");
  const [browse, setBrowse] = useState(false);

  useEffect(() => { setScan("idle"); setDetected(""); setBrowse(false); }, [project]);

  async function runScan() {
    if (scan === "scanning") return;
    setScan("scanning");
    try {
      // Closest existing call: the run-command detector reads the project's
      // dependencies/config to identify its stack.
      const r = await api.detectPreview({ project });
      setDetected(r.explanation || r.command || "no stack detected");
    } catch (e) {
      setDetected((e as Error).message || "scan failed");
    }
    setScan("done");
  }

  // Single scope until a monorepo-scope endpoint exists.
  const scopes = [{ label: name, sub: "repository root", icon: "⌂", count: "0" }];

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", border: "1px solid rgba(127,233,216,.14)", minHeight: 420 }}>
        {/* scope list */}
        <div style={{ borderRight: "1px solid rgba(127,233,216,.12)", display: "flex", flexDirection: "column", minHeight: 0, background: "rgba(7,13,13,.35)" }}>
          <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "#3c544f", padding: "11px 12px 9px", flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
            <span>SCOPE</span>
            {scopes.length > 1 && <span style={{ fontSize: 8, letterSpacing: 1, color: "#b9a6ff", border: "1px solid rgba(185,166,255,.3)", padding: "1px 5px" }}>MONOREPO</span>}
          </div>
          <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {scopes.map((sc, i) => (
              <button key={sc.label} {...hp(`sc:${i}`)}
                style={{ width: "100%", appearance: "none", border: 0, borderLeft: "2px solid #7fe9d8", background: hov === `sc:${i}` ? "rgba(127,233,216,.05)" : "rgba(127,233,216,.06)", cursor: "pointer", textAlign: "left", fontFamily: "inherit", padding: "9px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "#b9a6ff", flex: "none" }}>{sc.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 11.5, color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sc.label}</span>
                  <span style={{ display: "block", fontSize: 8.5, color: "#3c544f", marginTop: 2 }}>{sc.sub}</span>
                </span>
                <span style={{ fontSize: 9, color: "#6f938d", flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>{sc.count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* skills for the selected scope */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "12px 14px 10px", borderBottom: "1px solid rgba(127,233,216,.1)" }}>
            <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f" }}>SKILLS ·</span>
            <span style={{ fontSize: 12, color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 9, color: "#6f938d", flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>0 installed</span>
          </div>
          <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "12px 14px" }}>
            {/* scan card */}
            <div style={{ border: "1px solid rgba(127,233,216,.16)", background: "rgba(7,13,13,.35)", padding: "12px 13px", marginBottom: 14 }}>
              {scan === "idle" && (
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#7fe9d8" strokeWidth="1.6" strokeLinecap="round" style={{ flex: "none" }}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "#dff8f2" }}>Scan this scope for skills</div>
                    <div style={{ fontSize: 9.5, color: "#6f938d", marginTop: 2 }}>Detects the stack and suggests skills that match.</div>
                  </div>
                  <button onClick={() => void runScan()} {...hp("scan")}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid #7fe9d8", background: hov === "scan" ? "rgba(127,233,216,.22)" : "rgba(127,233,216,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: "8px 13px", flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: "#7fe9d8" }}>▸</span>SCAN PROJECT</button>
                </div>
              )}
              {scan === "scanning" && (
                <div style={{ display: "flex", alignItems: "center", gap: 11, color: "#7fe9d8" }}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#7fe9d8" strokeWidth="2" style={{ flex: "none", transformOrigin: "center", animation: "introspin 1s linear infinite" }}><path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" /></svg>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}>Scanning {name} — reading dependencies and source…</div>
                </div>
              )}
              {scan === "done" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 8, letterSpacing: 1.5, color: "#8fd9a8", flex: "none" }}>DETECTED</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: "#bfe6de", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{detected}</span>
                  <button onClick={() => void runScan()} title="rescan" {...hp("rescan")}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: hov === "rescan" ? "rgba(127,233,216,.08)" : "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "5px 9px", flex: "none" }}>↻ RESCAN</button>
                </div>
              )}
            </div>

            {/* installed */}
            <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "#3c544f", marginBottom: 8, display: "flex", alignItems: "center", gap: 7 }}>
              <span>INSTALLED · 0</span>
              <span style={{ flex: 1, height: 1, background: "rgba(127,233,216,.1)" }} />
            </div>
            <div style={{ fontSize: 11, color: "#3c544f", padding: "2px 2px 6px" }}>No skills installed for this scope.</div>

            <button onClick={() => setBrowse((b) => !b)} {...hp("browse")}
              style={{ width: "100%", marginTop: 9, appearance: "none", cursor: "pointer", border: `1px dashed ${hov === "browse" ? "rgba(127,233,216,.4)" : "rgba(127,233,216,.25)"}`, background: hov === "browse" ? "rgba(127,233,216,.05)" : "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <span style={{ color: "#7fe9d8", fontSize: 12, lineHeight: 0 }}>+</span>{browse ? "CLOSE CATALOG" : "BROWSE SKILL CATALOG"}</button>
            {browse && (
              <div style={{ marginTop: 10, border: "1px solid rgba(127,233,216,.14)", padding: 10, animation: "mslide .18s ease both" }}>
                <div style={{ fontSize: 8, letterSpacing: 1.5, color: "#3c544f", marginBottom: 8 }}>SKILL CATALOG</div>
                <div style={{ fontSize: 11, color: "#3c544f", padding: "2px 0 4px" }}>Catalog unavailable — skills backend not wired yet.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
