import type { TrayItem } from "@selector/controller";
import type { DevServerInfo } from "../../api";
import { ProjectRunBar } from "./ProjectRunBar";
import { SelectionTray } from "./SelectionTray";
import { useDraggable } from "./useDraggable";

const PRESETS = [
  { label: "Mobile", w: 375 },
  { label: "Tablet", w: 768 },
  { label: "Laptop", w: 1280 },
  { label: "Desktop", w: 1440 },
] as const;

function basename(rel: string | null): string {
  if (!rel) return "—";
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean || "—";
}

const tinyBtn = (on: boolean) => ({
  appearance: "none" as const, cursor: "pointer", fontFamily: "inherit", fontSize: 9,
  letterSpacing: 1, padding: "3px 8px",
  border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 16%, transparent)"}`,
  background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
  color: on ? "var(--txb)" : "var(--txd)",
});

/** The single floating, draggable, collapsible tooltip that holds every preview
 * control, overlaid on the fullscreen preview. */
export function PreviewControls(props: {
  // context
  project: string | null;
  branch?: string | null;
  source: "localhost" | "deployed";
  onSource: (s: "localhost" | "deployed") => void;
  hasProd: boolean;
  collapsed: boolean;
  onCollapsed: (v: boolean) => void;
  onClose: () => void;
  // run bar
  cmd: string; onCmd: (v: string) => void; placeholder: string;
  prodUrl: string; onProdUrl: (v: string) => void;
  status: string; port: number | null;
  onStart: () => void; onStop: () => void; onSave: () => void; busyRun: boolean;
  onLearn: () => void; learning: boolean;
  // viewport + select
  width: number; onWidth: (w: number) => void;
  selecting: boolean; onToggleSelect: () => void; canSelect: boolean; hoverLabel: string | null;
  // selection + submit
  items: TrayItem[]; onNote: (id: string, n: string) => void; onRemove: (id: string) => void;
  instruction: string; onInstruction: (v: string) => void;
  onSubmit: () => void; sending: boolean;
  // concurrent-previews switcher
  servers: DevServerInfo[]; activeDir: string | null; onSwitch: (s: DevServerInfo) => void;
}) {
  const { pos, onPointerDown } = useDraggable("mystical:preview-controls", { x: window.innerWidth - 380, y: 24 });
  const others = props.servers.filter((s) => s.status === "running");

  return (
    <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 70, width: props.collapsed ? "auto" : 340,
      border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--panel2) 96%, transparent)", boxShadow: "0 18px 60px rgba(0,0,0,.55)",
      display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 48px)" }}>
      {/* drag handle / header */}
      <div onPointerDown={onPointerDown}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "move",
          userSelect: "none", borderBottom: props.collapsed ? "none" : "1px solid color-mix(in srgb, var(--acc) 15%, transparent)", flex: "none" }}>
        <span style={{ fontSize: 9, letterSpacing: 1, color: "var(--acc)", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", padding: "2px 7px", flex: "none" }}>PREVIEW</span>
        <span style={{ fontSize: 11, color: "var(--txb)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{basename(props.project)}</span>
        {props.branch && (
          <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", fontSize: 9, color: "var(--purple-d)", border: "1px solid color-mix(in srgb, var(--purple) 28%, transparent)", padding: "2px 7px" }}>
            <span style={{ color: "var(--purple)" }}>⎇</span>{props.branch}
          </span>
        )}
        <button data-no-drag onClick={() => props.onCollapsed(!props.collapsed)} title={props.collapsed ? "Expand" : "Collapse"}
          style={{ marginLeft: "auto", appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>
          {props.collapsed ? "▣" : "▁"}
        </button>
        <button data-no-drag onClick={props.onClose} title="Close preview"
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)", background: "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>✕</button>
      </div>

      {!props.collapsed && (
        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {/* source toggle */}
          <div style={{ display: "flex", gap: 0, padding: "8px 10px 0" }}>
            {(["localhost", "deployed"] as const).map((s) => (
              <button key={s} onClick={() => props.onSource(s)} disabled={s === "deployed" && !props.hasProd}
                title={s === "deployed" && !props.hasProd ? "Set a production URL below first" : `Show ${s}`}
                style={{ ...tinyBtn(props.source === s), opacity: s === "deployed" && !props.hasProd ? 0.4 : 1 }}>
                {s.toUpperCase()}
              </button>
            ))}
          </div>

          <ProjectRunBar project={props.project} cmd={props.cmd} onCmd={props.onCmd} placeholder={props.placeholder}
            prodUrl={props.prodUrl} onProdUrl={props.onProdUrl} serverStatus={props.status} port={props.port}
            onStart={props.onStart} onStop={props.onStop} onSave={props.onSave}
            onLearn={props.onLearn} learning={props.learning} busy={props.busyRun} />

          <div style={{ height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />

          {/* viewport presets + select */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "8px 10px" }}>
            {PRESETS.map((p) => (
              <button key={p.w} onClick={() => props.onWidth(p.w)} style={tinyBtn(props.width === p.w)}>
                {p.label} <span style={{ opacity: 0.6 }}>{p.w}</span>
              </button>
            ))}
            <input type="number" value={props.width} onChange={(e) => props.onWidth(Number(e.target.value) || props.width)}
              style={{ width: 64, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "3px 6px" }} />
            <button onClick={props.onToggleSelect} disabled={!props.canSelect}
              title={props.canSelect ? "Toggle element select" : "Element select needs the dev server (localhost)"}
              style={{ ...tinyBtn(props.selecting), opacity: props.canSelect ? 1 : 0.4 }}>SELECT</button>
            {props.hoverLabel && <span style={{ fontSize: 10, opacity: 0.7, fontFamily: "'JetBrains Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.hoverLabel}</span>}
          </div>

          {/* selection + instruction + send */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 10px 10px" }}>
            {props.source === "deployed" ? (
              <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>Production preview — element selection needs the dev server (localhost).</p>
            ) : (
              <SelectionTray items={props.items} onNote={props.onNote} onRemove={props.onRemove} />
            )}
            <textarea value={props.instruction} onChange={(e) => props.onInstruction(e.target.value)}
              placeholder="What should Claude change?" rows={3}
              style={{ width: "100%", resize: "vertical", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: 12, padding: "6px 8px" }} />
            <button onClick={props.onSubmit} disabled={props.sending || !props.instruction.trim() || !props.items.length}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--acc)", background: "color-mix(in srgb, var(--acc) 14%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 11, letterSpacing: 1, padding: "7px 10px", opacity: props.sending || !props.instruction.trim() || !props.items.length ? 0.4 : 1 }}>
              SEND TO CLAUDE ▸
            </button>
          </div>

          {/* concurrent previews switcher */}
          {others.length > 1 && (
            <div style={{ borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--txl)" }}>RUNNING PREVIEWS</span>
              {others.map((s) => {
                const on = s.dir === props.activeDir;
                return (
                  <button key={s.dir} onClick={() => props.onSwitch(s)}
                    style={{ ...tinyBtn(on), display: "flex", alignItems: "center", gap: 6, textAlign: "left", padding: "4px 7px" }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ok)", flex: "none" }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename(s.project || s.dir)}{s.branch ? ` ⎇${s.branch}` : ""}</span>
                    <span style={{ marginLeft: "auto", opacity: 0.6, flex: "none" }}>{s.port ? `:${s.port}` : "…"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
