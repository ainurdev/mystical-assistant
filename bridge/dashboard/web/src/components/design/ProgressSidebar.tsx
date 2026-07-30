import { useEffect, useState, type CSSProperties } from "react";
import type { QueueItem } from "../../api";
import { SteerIcon } from "../Composer";
import type { RunProgress } from "./usePreviewQueue";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export interface ProgressSidebarProps {
  open: boolean;
  dockStyle: CSSProperties;
  running: QueueItem | null;
  progress: RunProgress;
  queued: QueueItem[];
  paused: boolean;
  onClose: () => void;
  onBump: (id: string) => void;
  onTogglePause: () => void;
}

/** Slides out from the edge of the preview window when a run is active. Shows the
 * running prompt's live tool-call stream (from the real session SSE) + what's next. */
export function ProgressSidebar(p: ProgressSidebarProps) {
  const { running, queued, open, dockStyle, progress } = p;
  const [secs, setSecs] = useState(0);
  const runId = running?.id ?? null;
  useEffect(() => {
    if (!runId) return;
    setSecs(0);
    const id = setInterval(() => setSecs((s) => +(s + 0.1).toFixed(1)), 100);
    return () => clearInterval(id);
  }, [runId]);

  const tools = progress.tools;

  return (
    <div style={{ ...dockStyle, position: "fixed", zIndex: 64, display: "flex", flexDirection: "column",
      border: "1px solid var(--border-bright)", borderRight: "none", background: "rgba(6,11,11,.97)",
      boxShadow: "-18px 0 50px var(--shadow-pop)", backdropFilter: "blur(2px)",
      transform: open ? "translateX(0)" : "translateX(18px)", opacity: open ? 1 : 0,
      pointerEvents: open ? "auto" : "none",
      transition: "transform .32s var(--ease-hud), opacity .28s var(--ease-hud)", overflow: "hidden" }}>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--border)", flex: "none" }}>
        <span style={{ color: "var(--primary)", animation: running ? "twinkle 1.4s infinite" : "none", fontSize: 13 }}>✦</span>
        <span className="glow" style={{ fontSize: 10, letterSpacing: 2, color: "var(--foreground-bright)" }}>{running ? "CHANNELING" : "STANDING BY"}</span>
        <span style={{ flex: 1 }} />
        {running && <span style={{ fontSize: 10, color: "var(--muted-foreground)", fontFamily: MONO }}>{secs.toFixed(1)}s</span>}
        <button onClick={p.onClose} title="Hide progress"
          style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>✕</button>
      </div>

      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {running ? (
          <>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--foreground-bright)" }}>{running.text}</div>
            {running.sel && running.sel.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {running.sel.map((a, i) => (
                  <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9.5, color: "var(--muted-foreground)", border: "1px solid var(--border)", padding: "2px 6px" }}>
                    <span style={{ color: "var(--primary)" }}>⌖</span>{a.label}
                  </span>
                ))}
              </div>
            )}
            {progress.steers.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 7, fontSize: 11.5, lineHeight: 1.45, color: "var(--violet)", borderLeft: "2px solid var(--violet)", paddingLeft: 8 }}>
                <span style={{ flex: "none", marginTop: 2 }}><SteerIcon size={12} /></span><span>{s}</span>
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 9, letterSpacing: 1.5, color: "var(--muted-2)", marginTop: 2 }}>
              <span>TOOL STREAM</span><span>{tools.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {tools.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ color: "var(--primary)" }}>{t.name}</span>
                    <span style={{ color: "var(--muted-foreground)" }}> {t.summary}</span>
                  </span>
                  {t.state === "running"
                    ? <span style={{ color: "var(--primary)", flex: "none", display: "inline-block", animation: "introspin .8s linear infinite" }}>◜</span>
                    : <span style={{ color: "var(--success)", flex: "none", fontSize: 11 }}>✓</span>}
                </div>
              ))}
              {tools.length === 0 && <span style={{ fontSize: 11, color: "var(--muted-foreground)", fontStyle: "italic", paddingLeft: 4 }}>summoning the runtime…</span>}
            </div>
          </>
        ) : (
          <div style={{ paddingTop: 8, fontSize: 12, fontStyle: "italic", color: "var(--muted-foreground)" }}>
            {p.paused ? "the queue is held — resume to continue."
              : queued.length ? "the next intent gathers…"
                : "idle, but never asleep — what shall we ship?"}
          </div>
        )}

        {/* next up */}
        <div style={{ marginTop: "auto", borderTop: "1px dashed var(--border)", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--muted-2)" }}>NEXT UP</span>
            <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span style={{ fontSize: 9, color: "var(--muted-foreground)" }}>{queued.length}</span>
          </div>
          {queued.length === 0 ? (
            <span style={{ fontSize: 11, color: "var(--muted-2)", fontStyle: "italic" }}>nothing waiting.</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {queued.slice(0, 4).map((it, i) => (
                <div key={it.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 11.5, color: "var(--muted-foreground)" }}>
                  <span style={{ fontFamily: MONO, color: "var(--muted-2)", flex: "none", paddingTop: 1 }}>{String(i + 1).padStart(2, "0")}</span>
                  <span style={{ flex: 1, lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{it.text}</span>
                  <button onClick={() => p.onBump(it.id)} title="Run this one next"
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "2px 6px", flex: "none" }}>↑</button>
                </div>
              ))}
              {queued.length > 4 && <span style={{ fontSize: 10, color: "var(--muted-2)", paddingLeft: 22 }}>+{queued.length - 4} more</span>}
            </div>
          )}
        </div>
      </div>

      {/* footer status */}
      <div style={{ borderTop: "1px solid var(--border)", padding: "7px 12px", display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: running ? "var(--primary)" : "var(--muted-2)", animation: running ? "mpulse 2.4s infinite" : undefined }} />
        <span style={{ fontSize: 9, letterSpacing: 1, color: "var(--muted-foreground)" }}>{running ? "AGENT WORKING" : p.paused ? "PAUSED" : "QUEUE IDLE"}</span>
        <span style={{ flex: 1 }} />
        <button onClick={p.onTogglePause}
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${p.paused ? "var(--warning)" : "var(--border)"}`, background: "transparent", color: p.paused ? "var(--warning)" : "var(--muted-foreground)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 9px" }}>
          {p.paused ? "▶ RESUME" : "⏸ PAUSE"}
        </button>
      </div>
    </div>
  );
}
