import { useEffect, useState } from "react";
import { api, type DevServerInfo } from "../../api";
import { projectTint } from "../../lib/surfaces";

/* PROJECT PREVIEW modal — matches the HUD design mock (hud.dc.html lines
   1320–1356): browser chrome (traffic-light dots, live URL bar with pulse dot +
   project tag, ESC ✕) over the project's running dev preview. Reuses the
   bridge's dev-server registry (api.servers, same source RunningWindow polls)
   to embed the real localhost iframe; with no server up it shows the design's
   placeholder body. */

function basename(rel: string): string {
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

export function ProjectPreviewModal({ project, onClose }: {
  project: string;
  onClose: () => void;
}) {
  const [servers, setServers] = useState<DevServerInfo[]>([]);
  const [escHov, setEscHov] = useState(false);

  // Poll the running dev servers (same cadence as RunningWindow) so the modal
  // picks up URL detection + external stops while open.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const r = await api.servers(); if (live) setServers(r.servers); } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 2500);
    return () => { live = false; clearInterval(id); };
  }, []);

  const server = servers.find((s) => s.project === project && !!s.url) ?? null;
  const url = server?.url ?? null;
  const tint = projectTint(project);
  const name = basename(project);
  const displayUrl = url ? url.replace(/^https?:\/\//, "") : "localhost:—";

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(4,7,7,.8)", zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", padding: "5vh 4vw", animation: "backdropIn .2s ease both" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 1000, maxWidth: "95vw", height: 640, maxHeight: "88vh", display: "flex", flexDirection: "column", border: "1px solid rgba(127,233,216,.4)", background: "#0a1113", boxShadow: "0 0 70px rgba(0,0,0,.85)", animation: "mslide .2s ease both", overflow: "hidden" }}>
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 11, padding: "9px 13px", background: "rgba(7,13,13,.9)", borderBottom: "1px solid rgba(127,233,216,.16)" }}>
          <span style={{ display: "flex", gap: 6, flex: "none" }}>
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#e0897a" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#e3c279" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#8fd9a8" }} />
          </span>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "rgba(4,7,7,.6)", border: "1px solid rgba(127,233,216,.14)", padding: "5px 11px", minWidth: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#8fd9a8", flex: "none", animation: "mpulse 2.4s infinite" }} />
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "#9fc7c0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{displayUrl}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 8, letterSpacing: 1, color: tint.color, border: `1px solid ${tint.border}`, padding: "1px 5px", flex: "none" }}>{tint.tag}</span>
          </div>
          <button onClick={onClose} title="close preview"
            onMouseEnter={() => setEscHov(true)} onMouseLeave={() => setEscHov(false)}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: escHov ? "rgba(127,233,216,.08)" : "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.5, padding: "6px 11px", flex: "none" }}>ESC ✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", background: "radial-gradient(120% 100% at 50% 0%, rgba(127,233,216,.05), transparent 60%), #0a1113" }}>
          {url ? (
            <iframe src={url} title="project preview"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "#fff" }} />
          ) : (
            /* TODO(phase2-data): no dev server running for this project yet — design placeholder body */
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 14, padding: "20px 28px", borderBottom: "1px solid rgba(127,233,216,.1)" }}>
                <span style={{ width: 30, height: 30, border: `2px solid ${tint.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: tint.color, flex: "none" }}>{tint.tag}</span>
                <span style={{ fontSize: 17, color: "#eafff9", letterSpacing: ".3px" }}>{name}</span>
                <span style={{ flex: 1 }} />
                <span style={{ display: "flex", gap: 20, fontSize: 12, color: "#6f938d" }}>Docs · Pricing · Sign in</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, padding: 30, textAlign: "center" }}>
                <span style={{ fontSize: 40, lineHeight: 1.15, color: "#eafff9", maxWidth: 640, fontWeight: 600 }}>Ship faster with {name}</span>
                <span style={{ fontSize: 15, color: "#9fc7c0", maxWidth: 520, lineHeight: 1.6 }}>Live dev preview served from {displayUrl} — hot-reloading against your current worktree.</span>
                <span style={{ display: "flex", gap: 12, marginTop: 4 }}>
                  <span style={{ padding: "11px 22px", background: tint.color, color: "#06100e", fontSize: 13, fontWeight: 600 }}>Get started</span>
                  <span style={{ padding: "11px 22px", border: "1px solid rgba(127,233,216,.3)", color: "#cfe9e3", fontSize: 13 }}>Live demo</span>
                </span>
                <div style={{ display: "flex", gap: 14, marginTop: 26 }}>
                  <span style={{ width: 150, height: 88, border: "1px solid rgba(127,233,216,.14)", background: "rgba(127,233,216,.04)" }} />
                  <span style={{ width: 150, height: 88, border: "1px solid rgba(127,233,216,.14)", background: "rgba(127,233,216,.04)" }} />
                  <span style={{ width: 150, height: 88, border: "1px solid rgba(127,233,216,.14)", background: "rgba(127,233,216,.04)" }} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
