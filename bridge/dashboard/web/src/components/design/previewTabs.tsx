import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { TrayItem } from "@selector/controller";
import type { QueueItem } from "../../api";
import { ProjectRunBar } from "./ProjectRunBar";
import { SelectionTray } from "./SelectionTray";

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const UI = "var(--font-display)";

export const tinyBtn = (on: boolean): CSSProperties => ({
  appearance: "none", cursor: "pointer", fontFamily: UI, fontSize: 9.5, letterSpacing: 1,
  padding: "4px 9px", border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
  background: on ? "var(--ac-08)" : "transparent",
  color: on ? "var(--foreground-bright)" : "var(--muted-foreground)", transition: "all .12s",
});
const ctlInput: CSSProperties = {
  background: "var(--card)", border: "1px solid var(--input)", outline: "none",
  color: "var(--foreground-bright)", fontFamily: MONO, fontSize: 12, padding: "7px 9px",
};
const PRESETS: [string, number][] = [["Mobile", 375], ["Tablet", 768], ["Laptop", 1280], ["Desktop", 1440]];

const MODELS = [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }];
const EFFORTS = [{ id: "", label: "Auto" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium" },
  { id: "high", label: "High" }, { id: "xhigh", label: "XHigh" }, { id: "max", label: "Max" }];
const PERMS = [{ id: "default", label: "Ask" }, { id: "acceptEdits", label: "Accept Edits" },
  { id: "plan", label: "Plan" }, { id: "auto", label: "Auto-run" }, { id: "bypassPermissions", label: "Full Auto" }];

/** A compact label + dropdown (model/effort/mode), opening upward over the composer. */
function Drop({ label, value, options, minWidth = 86, onPick }: {
  label: string; value: string; options: { id: string; label: string }[];
  minWidth?: number; onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.id === value) ?? options[0];
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--muted-2)", flex: "none" }}>{label}</span>
      <button onClick={() => setOpen((v) => !v)} data-no-drag style={{
        appearance: "none", cursor: "pointer", border: "1px solid var(--input)", background: "var(--card)",
        color: "var(--foreground)", fontFamily: UI, fontSize: 9.5, letterSpacing: ".3px",
        padding: "4px 9px", display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", minWidth,
      }}>
        {cur.label}<span style={{ color: "var(--muted-foreground)", fontSize: 8 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 25 }} />
          <div style={{
            position: "absolute", bottom: "calc(100% + 5px)", left: 0, minWidth: 132, zIndex: 26,
            border: "1px solid var(--border-bright)", background: "var(--popover)",
            boxShadow: "0 -8px 26px rgba(0,0,0,.65)", animation: "mpop .12s ease",
          }}>
            {options.map((o) => (
              <button key={o.id} onClick={() => { onPick(o.id); setOpen(false); }} style={{
                width: "100%", appearance: "none", cursor: "pointer", border: 0,
                borderBottom: "1px solid var(--ac-08)", background: o.id === value ? "var(--ac-08)" : "transparent",
                color: o.id === value ? "var(--foreground-bright)" : "var(--foreground)", fontFamily: UI,
                fontSize: 10.5, textAlign: "left", padding: "8px 11px", display: "flex", alignItems: "center", gap: 8,
              }}>
                <span style={{ width: 8, color: "var(--primary)", flex: "none" }}>{o.id === value ? "✓" : ""}</span>
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ============================== PREVIEW ====================================
export interface PreviewTabProps {
  source: "localhost" | "deployed";
  onSource: (s: "localhost" | "deployed") => void;
  hasProd: boolean;
  project: string | null;
  cmd: string; onCmd: (v: string) => void; placeholder: string;
  prodUrl: string; onProdUrl: (v: string) => void;
  serverStatus: string; port: number | null;
  onStart: () => void; onStop: () => void; onSave: () => void;
  onLearn: () => void; learning: boolean; busyRun: boolean;
  width: number; onWidth: (w: number) => void;
  selecting: boolean; onToggleSelect: () => void; canSelect: boolean; hoverLabel: string | null;
  items: TrayItem[]; onNote: (id: string, n: string) => void; onRemove: (id: string) => void;
  instruction: string; onInstruction: (v: string) => void;
  onSend: () => void; sendLabel: string; sendHint: string;
  model: string; onModel: (m: string) => void;
  effort: string; onEffort: (e: string) => void;
  mode: string; onMode: (m: string) => void;
}

export function PreviewTab(p: PreviewTabProps) {
  const running = p.serverStatus === "running";
  const dot = running ? "var(--success)" : p.serverStatus === "exited" ? "var(--danger)" : "var(--muted-2)";
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* source toggle */}
      <div style={{ display: "flex", padding: "10px 12px 0" }}>
        {(["localhost", "deployed"] as const).map((s) => (
          <button key={s} onClick={() => p.onSource(s)} data-no-drag disabled={s === "deployed" && !p.hasProd}
            title={s === "deployed" && !p.hasProd ? "Set a production URL first" : `Show ${s}`}
            style={{ ...tinyBtn(p.source === s), padding: "5px 12px", opacity: s === "deployed" && !p.hasProd ? 0.4 : 1 }}>
            {s.toUpperCase()}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 9, letterSpacing: 1, color: dot }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, animation: running ? "mpulse 2.4s infinite" : undefined }} />
          {p.serverStatus.toUpperCase()}{running && p.port ? `  :${p.port}` : ""}
        </span>
      </div>

      {/* run command bar (reused from the existing controls) */}
      <ProjectRunBar project={p.project} cmd={p.cmd} onCmd={p.onCmd} placeholder={p.placeholder}
        prodUrl={p.prodUrl} onProdUrl={p.onProdUrl} serverStatus={p.serverStatus} port={p.port}
        onStart={p.onStart} onStop={p.onStop} onSave={p.onSave}
        onLearn={p.onLearn} learning={p.learning} busy={p.busyRun} />

      <div style={{ height: 1, background: "var(--border)" }} />

      {/* viewport + select */}
      <div style={{ padding: "11px 12px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--muted-2)", flex: "1 1 100%" }}>VIEWPORT</span>
        {PRESETS.map(([label, w]) => (
          <button key={w} data-no-drag onClick={() => p.onWidth(w)} style={tinyBtn(p.width === w)}>
            {label} <span style={{ opacity: 0.6 }}>{w}</span>
          </button>
        ))}
        <input type="number" value={p.width} onChange={(e) => p.onWidth(Number(e.target.value) || p.width)}
          style={{ ...ctlInput, width: 62, padding: "4px 7px" }} />
        <button data-no-drag onClick={p.onToggleSelect} disabled={!p.canSelect}
          title={p.canSelect ? "Pick elements in the preview" : "Element select needs localhost"}
          style={{ ...tinyBtn(p.selecting), opacity: p.canSelect ? 1 : 0.4, marginLeft: "auto" }}>
          {p.selecting ? "◉ SELECTING" : "⊕ SELECT"}
        </button>
        {p.hoverLabel && <span style={{ fontSize: 10, color: "var(--muted-foreground)", fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 100%" }}>{p.hoverLabel}</span>}
      </div>

      {/* selection tray */}
      <div style={{ padding: "0 12px 4px" }}>
        {p.source === "deployed"
          ? <p style={{ margin: 0, fontSize: 11, color: "var(--muted-foreground)", fontStyle: "italic" }}>production preview — element selection needs the dev server (localhost).</p>
          : <SelectionTray items={p.items} onNote={p.onNote} onRemove={p.onRemove} />}
      </div>

      {/* composer */}
      <div style={{ marginTop: 6, borderTop: "1px solid var(--border)", padding: "11px 12px", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Drop label="MODEL" value={p.model} options={MODELS} onPick={p.onModel} />
          <Drop label="EFFORT" value={p.effort} options={EFFORTS} onPick={p.onEffort} />
          <Drop label="MODE" value={p.mode} options={PERMS} minWidth={104} onPick={p.onMode} />
        </div>
        <textarea value={p.instruction} onChange={(e) => p.onInstruction(e.target.value)} rows={3}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); p.onSend(); } }}
          placeholder="describe a change — it joins the queue and runs in turn…"
          style={{ ...ctlInput, resize: "vertical", lineHeight: 1.5 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, color: "var(--muted-foreground)", fontStyle: "italic", flex: 1, lineHeight: 1.4 }}>{p.sendHint}</span>
          <button data-no-drag onClick={p.onSend} disabled={!p.instruction.trim()}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--primary)", background: "var(--ac-12)", color: "var(--foreground-bright)", fontFamily: UI, fontSize: 11, letterSpacing: 1.5, padding: "8px 14px", opacity: p.instruction.trim() ? 1 : 0.4 }}>
            {p.sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ================================ LOGS =====================================
function logColor(l: string): string {
  if (/✗|error|fail|exited/i.test(l)) return "var(--danger)";
  if (/✓|ready|hmr|connected|built/i.test(l)) return "var(--success)";
  if (/^\s*\$|vite\]/i.test(l)) return "var(--violet)";
  if (/^\s*➜|Local|Network/i.test(l)) return "var(--primary)";
  if (/GET|POST|\d{2}:\d{2}/.test(l)) return "var(--muted-foreground)";
  return "var(--foreground)";
}
export interface LogsTabProps {
  lines: string[]; running: boolean; port: number | null;
  autoscroll: boolean; onAutoscroll: (v: boolean) => void; onClear: () => void;
  filter: string; onFilter: (f: string) => void;
}
export function LogsTab(p: LogsTabProps) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = p.filter === "hmr" ? p.lines.filter((l) => /vite\]|hmr/i.test(l))
    : p.filter === "err" ? p.lines.filter((l) => /✗|error|fail/i.test(l)) : p.lines;
  useEffect(() => { if (p.autoscroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [p.lines.length, p.autoscroll]);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", flexWrap: "wrap", flex: "none" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 9.5, letterSpacing: 1.5, color: p.running ? "var(--success)" : "var(--muted-2)" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.running ? "var(--success)" : "var(--muted-2)", animation: p.running ? "mpulse 2.4s infinite" : undefined }} />
          DEV SERVER{p.running ? `  :${p.port}` : "  OFFLINE"}
        </span>
        <span style={{ fontSize: 9, color: "var(--muted-2)" }}>{p.lines.length} LINES</span>
        <span style={{ flex: 1 }} />
        {([["all", "ALL"], ["hmr", "HMR"], ["err", "ERR"]] as const).map(([k, lbl]) => (
          <button key={k} data-no-drag onClick={() => p.onFilter(k)} style={tinyBtn(p.filter === k)}>{lbl}</button>
        ))}
        <button data-no-drag onClick={() => p.onAutoscroll(!p.autoscroll)} style={tinyBtn(p.autoscroll)} title="Stick to newest line">⤓ FOLLOW</button>
        <button data-no-drag onClick={p.onClear} style={tinyBtn(false)}>CLEAR</button>
      </div>
      <div ref={ref} className="mscroll" style={{ flex: 1, minHeight: 0, margin: "0 12px 12px", padding: "10px 12px", background: "rgba(0,0,0,.32)", border: "1px solid var(--border)", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.65 }}>
        {shown.length === 0 ? (
          <div style={{ color: "var(--muted-foreground)", fontStyle: "italic" }}>
            {p.running ? "no matching output." : "the server sleeps — press RUN to wake it."}
          </div>
        ) : shown.map((l, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", color: logColor(l) }}>{l || " "}</div>
        ))}
        {p.running && <div style={{ color: "var(--primary)" }}>▌</div>}
      </div>
    </div>
  );
}

// ================================ QUEUE ====================================
const STATUS: Record<string, { c: string; t: string }> = {
  queued: { c: "var(--muted-foreground)", t: "QUEUED" },
  running: { c: "var(--primary)", t: "RUNNING" },
  done: { c: "var(--success)", t: "DONE" },
  failed: { c: "var(--danger)", t: "FAILED" },
};

function Anchor({ label }: { label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9.5, color: "var(--muted-foreground)", border: "1px solid var(--border)", padding: "2px 6px" }}>
      <span style={{ color: "var(--primary)" }}>⌖</span>{label}
    </span>
  );
}

interface QueueCardProps {
  it: QueueItem; runningTool: string | null; dragId: string | null;
  onDragStart: (id: string) => void; onReorder: (from: string, to: string) => void;
  onBump: (id: string) => void; onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void; onCancel: (id: string) => void;
  onRetry: (id: string) => void; onShowProgress: () => void;
}
function QueueCard(p: QueueCardProps) {
  const { it } = p;
  const s = STATUS[it.status] ?? STATUS.queued;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(it.text);
  const queued = it.status === "queued";
  return (
    <div draggable={queued && !editing}
      onDragStart={(e: DragEvent) => { e.dataTransfer.effectAllowed = "move"; p.onDragStart(it.id); }}
      onDragOver={(e: DragEvent) => { if (p.dragId && queued) e.preventDefault(); }}
      onDrop={(e: DragEvent) => { e.preventDefault(); if (p.dragId && queued) p.onReorder(p.dragId, it.id); }}
      style={{ border: `1px solid ${it.status === "running" ? "var(--border-bright)" : "var(--border)"}`,
        background: it.status === "running" ? "var(--ac-06)" : "var(--ac-03)", padding: "9px 10px",
        opacity: p.dragId === it.id ? 0.4 : 1, position: "relative", overflow: "hidden" }}>
      {it.status === "running" && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,transparent,var(--primary),transparent)", backgroundSize: "200% 100%", animation: "awaitsweep 1.4s linear infinite" }} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {queued && <span title="drag to reorder" style={{ cursor: "grab", color: "var(--muted-2)", fontSize: 12, lineHeight: 1 }}>⠿</span>}
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.c, flex: "none", animation: it.status === "running" ? "mpulse 2.4s infinite" : undefined }} />
        <span style={{ fontSize: 9, letterSpacing: 1, color: s.c, border: `1px solid color-mix(in srgb, ${s.c} 40%, transparent)`, padding: "2px 6px" }}>{s.t}</span>
        {it.status === "running" && p.runningTool && <span style={{ fontSize: 10, color: "var(--muted-foreground)", fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.runningTool}</span>}
        <span style={{ flex: 1 }} />
        {it.status === "done" && it.elapsed != null && <span style={{ fontSize: 9.5, color: "var(--muted-2)", fontFamily: MONO }}>{it.elapsed}s{it.cost != null ? ` · $${it.cost.toFixed(4)}` : ""}</span>}
      </div>

      {editing ? (
        <div style={{ marginTop: 8 }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus
            style={{ ...ctlInput, width: "100%", resize: "vertical", fontSize: 12, lineHeight: 1.5 }} />
          <div style={{ display: "flex", gap: 7, marginTop: 6 }}>
            <span style={{ flex: 1 }} />
            <button data-no-drag onClick={() => { setDraft(it.text); setEditing(false); }} style={tinyBtn(false)}>CANCEL</button>
            <button data-no-drag onClick={() => { p.onEdit(it.id, draft.trim() || it.text); setEditing(false); }} style={tinyBtn(true)}>SAVE</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 7, fontSize: 12.5, lineHeight: 1.5, color: it.status === "done" ? "var(--muted-foreground)" : "var(--foreground-bright)" }}>{it.text}</div>
      )}

      {!editing && it.sel && it.sel.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
          {it.sel.map((a, i) => <Anchor key={i} label={a.label} />)}
          {it.width ? <Anchor label={`▭ ${it.width}`} /> : null}
        </div>
      )}

      {it.status === "done" && it.result && (
        <div style={{ marginTop: 8, paddingLeft: 9, borderLeft: "2px solid color-mix(in srgb, var(--success) 40%, transparent)", fontSize: 11, color: "var(--muted-foreground)", lineHeight: 1.5 }}>{it.result}</div>
      )}
      {it.status === "failed" && it.error && (
        <div style={{ marginTop: 8, paddingLeft: 9, borderLeft: "2px solid color-mix(in srgb, var(--danger) 40%, transparent)", fontSize: 11, color: "var(--danger)", lineHeight: 1.5 }}>{it.error}</div>
      )}

      {!editing && (
        <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
          {queued && <button data-no-drag onClick={() => p.onBump(it.id)} style={tinyBtn(false)} title="Run this one next">↑ NEXT</button>}
          {queued && <button data-no-drag onClick={() => setEditing(true)} style={tinyBtn(false)}>✎ EDIT</button>}
          {it.status === "running" && <button data-no-drag onClick={p.onShowProgress} style={tinyBtn(false)} title="Open the progress sidebar">◫ PROGRESS</button>}
          {it.status === "running" && <button data-no-drag onClick={() => p.onCancel(it.id)} style={{ ...tinyBtn(false), borderColor: "var(--danger)", color: "var(--danger)" }}>■ CANCEL</button>}
          {it.status === "failed" && <button data-no-drag onClick={() => p.onRetry(it.id)} style={{ ...tinyBtn(false), borderColor: "var(--violet)", color: "var(--violet)" }}>↻ RETRY</button>}
          <span style={{ flex: 1 }} />
          {it.status !== "running" && <button data-no-drag onClick={() => p.onRemove(it.id)} style={{ ...tinyBtn(false), color: "var(--muted-2)" }}>✕ REMOVE</button>}
        </div>
      )}
    </div>
  );
}

export interface QueueTabProps {
  items: QueueItem[]; paused: boolean; running: QueueItem | null; runningTool: string | null;
  onTogglePause: () => void; onClearDone: () => void;
  onRemove: (id: string) => void; onEdit: (id: string, text: string) => void;
  onCancel: (id: string) => void; onRetry: (id: string) => void; onBump: (id: string) => void;
  onReorder: (from: string, to: string) => void; onShowProgress: () => void;
}
export function QueueTab(p: QueueTabProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const pending = p.items.filter((x) => x.status === "queued").length;
  const done = p.items.filter((x) => x.status === "done" || x.status === "failed").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", flex: "none" }}>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--muted-foreground)" }}>QUEUE</span>
        <span style={{ fontSize: 9, color: "var(--primary)" }}>{pending} WAITING</span>
        {p.running && <span style={{ fontSize: 9, color: "var(--foreground-bright)" }}>· 1 RUNNING</span>}
        <span style={{ flex: 1 }} />
        {done > 0 && <button data-no-drag onClick={p.onClearDone} style={tinyBtn(false)}>CLEAR DONE</button>}
        <button data-no-drag onClick={p.onTogglePause} style={{ ...tinyBtn(p.paused), borderColor: p.paused ? "var(--warning)" : "var(--border)", color: p.paused ? "var(--warning)" : "var(--muted-foreground)" }}>
          {p.paused ? "▶ RESUME" : "⏸ PAUSE"}
        </button>
      </div>
      {p.paused && (
        <div style={{ margin: "0 12px 8px", padding: "6px 9px", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)", background: "rgba(227,194,121,.07)", fontSize: 10, letterSpacing: 0.5, color: "var(--warning)" }}>
          queue paused — the running task finishes, then nothing new starts.
        </div>
      )}
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 9 }}>
        {p.items.length === 0 ? (
          <div style={{ paddingTop: 28, textAlign: "center", fontSize: 12, fontStyle: "italic", color: "var(--muted-foreground)" }}>
            the queue is still — speak a change and it will gather here.
          </div>
        ) : p.items.map((it) => (
          <QueueCard key={it.id} it={it} runningTool={p.runningTool} dragId={dragId}
            onDragStart={setDragId} onReorder={(a, b) => { p.onReorder(a, b); setDragId(null); }}
            onBump={p.onBump} onEdit={p.onEdit} onRemove={p.onRemove} onCancel={p.onCancel}
            onRetry={p.onRetry} onShowProgress={p.onShowProgress} />
        ))}
      </div>
    </div>
  );
}
