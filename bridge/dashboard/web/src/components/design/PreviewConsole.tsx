import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { QueueItem } from "../../api";
import { usePreviewWindow } from "./usePreviewWindow";
import {
  PreviewTab, LogsTab, QueueTab,
  type PreviewTabProps, type LogsTabProps, type QueueTabProps,
} from "./previewTabs";
import { ProgressSidebar } from "./ProgressSidebar";
import type { RunProgress } from "./usePreviewQueue";

const UI = "var(--font-display)";

function Tab({ id, label, active, onClick, badge, live }: {
  id: string; label: string; active: string; onClick: (id: string) => void;
  badge?: number; live?: boolean;
}) {
  const on = active === id;
  return (
    <button data-no-drag onClick={() => onClick(id)} style={{ appearance: "none", cursor: "pointer", flex: 1,
      fontFamily: UI, fontSize: 10, letterSpacing: 1.5, padding: "8px 4px 7px", position: "relative",
      borderTop: `2px solid ${on ? "var(--primary)" : "transparent"}`, borderBottom: "none", borderLeft: "none", borderRight: "none",
      background: on ? "var(--ac-08)" : "transparent", color: on ? "var(--foreground-bright)" : "var(--muted-foreground)",
      transition: "all .14s", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
      {label}
      {live && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--success)", animation: "mpulse 2.4s infinite" }} />}
      {badge ? <span style={{ fontSize: 8.5, lineHeight: 1, padding: "2px 5px", background: on ? "var(--primary)" : "var(--ac-16)", color: on ? "var(--primary-foreground)" : "var(--foreground-bright)" }}>{badge}</span> : null}
    </button>
  );
}

export interface PreviewConsoleProps {
  project: string | null;
  branch: string | null;
  serverStatus: string;
  port: number | null;
  previewProps: PreviewTabProps;
  logsProps: LogsTabProps;
  queueProps: QueueTabProps;
  sidebar: {
    running: QueueItem | null;
    progress: RunProgress;
    queued: QueueItem[];
    paused: boolean;
    onBump: (id: string) => void;
    onTogglePause: () => void;
  };
  onClose: () => void;
}

/** The redesigned floating menu: a draggable / resizable / collapsible window with
 * PREVIEW · LOGS · QUEUE tabs, a status footer, and a progress sidebar that docks
 * to its side. Presentational — all domain state lives in RunningWindow. */
export function PreviewConsole(p: PreviewConsoleProps) {
  const { rect, startMove, startResize } = usePreviewWindow("mystical:preview-console", {
    x: window.innerWidth - 396, y: 22, w: 380, h: Math.min(640, window.innerHeight - 44),
  });
  const [activeTab, setTab] = useState("preview");
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const running = p.sidebar.running;
  const runningId = running?.id ?? null;
  const wasRunning = useRef(false);
  useEffect(() => {                       // pop the sidebar open the moment a run begins
    if (runningId && !wasRunning.current) setSidebarOpen(true);
    wasRunning.current = !!runningId;
  }, [runningId]);

  const pending = p.queueProps.items.filter((x) => x.status === "queued").length;
  const isRunning = p.serverStatus === "running";

  // Dock the sidebar to the window's left edge (or right if there's no room).
  const sbW = Math.min(304, Math.max(248, rect.x - 14));
  const dockLeft = rect.x >= sbW + 14;
  const dockStyle: CSSProperties = {
    width: sbW, top: rect.y,
    height: collapsed ? Math.min(420, window.innerHeight - rect.y - 16) : rect.h,
    left: dockLeft ? rect.x - sbW : Math.min(rect.x + rect.w, window.innerWidth - sbW - 6),
  };

  return (
    <>
      <ProgressSidebar open={sidebarOpen} dockStyle={dockStyle} running={running}
        progress={p.sidebar.progress} queued={p.sidebar.queued} paused={p.sidebar.paused}
        onClose={() => setSidebarOpen(false)} onBump={p.sidebar.onBump} onTogglePause={p.sidebar.onTogglePause} />

      <div style={{ position: "fixed", left: rect.x, top: rect.y, width: rect.w, height: collapsed ? "auto" : rect.h,
        zIndex: 66, display: "flex", flexDirection: "column", border: "1px solid var(--border-bright)",
        background: "color-mix(in srgb, var(--panel2) 96%, transparent)", boxShadow: "0 22px 64px rgba(0,0,0,.55)", animation: "mpop .3s var(--ease-hud) both" }}>

        {/* header / drag handle */}
        <div onPointerDown={startMove} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
          cursor: "move", userSelect: "none", borderBottom: collapsed ? "none" : "1px solid var(--border)", flex: "none" }}>
          <span style={{ fontSize: 9, letterSpacing: 1, color: "var(--primary)", border: "1px solid var(--border-bright)", padding: "2px 7px", flex: "none" }}>PREVIEW</span>
          <span style={{ fontSize: 12, color: "var(--foreground-bright)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.project ?? "—"}</span>
          {p.branch && (
            <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", fontSize: 9, color: "var(--violet)", border: "1px solid color-mix(in srgb, var(--purple) 28%, transparent)", padding: "2px 7px" }}>
              <span>⎇</span>{p.branch}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button data-no-drag onClick={() => setSidebarOpen((v) => !v)} title="Progress sidebar"
            style={{ appearance: "none", cursor: "pointer", border: `1px solid ${sidebarOpen ? "var(--primary)" : "var(--border)"}`, background: sidebarOpen ? "var(--ac-08)" : "transparent", color: sidebarOpen ? "var(--foreground-bright)" : "var(--muted-foreground)", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>◫</button>
          <button data-no-drag onClick={() => setCollapsed((v) => !v)} title={collapsed ? "Expand" : "Collapse"}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>{collapsed ? "▣" : "▁"}</button>
          <button data-no-drag onClick={p.onClose} title="Close preview"
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)", background: "transparent", color: "var(--danger)", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>✕</button>
        </div>

        {!collapsed && (
          <>
            {/* tab bar */}
            <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flex: "none" }}>
              <Tab id="preview" label="PREVIEW" active={activeTab} onClick={setTab} />
              <Tab id="logs" label="LOGS" active={activeTab} onClick={setTab} live={isRunning} />
              <Tab id="queue" label="QUEUE" active={activeTab} onClick={setTab} badge={pending} />
            </div>

            {/* body */}
            <div className="mscroll" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              {activeTab === "preview" && <PreviewTab {...p.previewProps} />}
              {activeTab === "logs" && <LogsTab {...p.logsProps} />}
              {activeTab === "queue" && <QueueTab {...p.queueProps} onShowProgress={() => setSidebarOpen(true)} />}
            </div>

            {/* footer */}
            <div style={{ flex: "none", borderTop: "1px solid var(--border)", padding: "7px 11px", display: "flex", alignItems: "center", gap: 9, fontSize: 9, letterSpacing: 1, color: "var(--muted-2)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: isRunning ? "var(--success)" : "var(--muted-2)" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: isRunning ? "var(--success)" : "var(--muted-2)", animation: isRunning ? "mpulse 2.4s infinite" : undefined }} />
                {isRunning && p.port ? `:${p.port}` : "OFFLINE"}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: p.sidebar.paused ? "var(--warning)" : "var(--muted-foreground)" }}>
                {running ? "● RUNNING" : p.sidebar.paused ? "❚❚ PAUSED" : pending ? `${pending} QUEUED` : "IDLE"}
              </span>
            </div>
          </>
        )}

        {/* resize handle */}
        {!collapsed && (
          <div onPointerDown={startResize} title="Drag to resize"
            style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", background: "linear-gradient(135deg,transparent 45%,var(--border-bright) 45%)" }} />
        )}
      </div>
    </>
  );
}
