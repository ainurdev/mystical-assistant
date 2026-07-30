import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, ChevronsRight, Merge, Paperclip, Square } from "lucide-react";
import { api, type EffortLevel, type GraphState, type ModelId } from "../api";
import { ago } from "../lib/surfaces";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";

export const EFFORTS: { id: EffortLevel | ""; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];
// Per-message operating mode ("" keeps the session's). Mirrors the CLI permission
// modes so you can flip a single run (ask / plan / full autonomy) remotely.
export const PERMS: { id: string; label: string }[] = [
  { id: "", label: "Session" },
  { id: "default", label: "Ask" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto-run" },
  { id: "bypassPermissions", label: "Full Auto" },
];
// Per-run code-minimalism intensity, threaded to the runner's env (Task 4/8).
export const PONYTAILS: { id: string; label: string }[] = [
  { id: "", label: "Default" },
  { id: "off", label: "Off" },
  { id: "lite", label: "Lite" },
  { id: "full", label: "Full" },
  { id: "ultra", label: "Ultra" },
];

const COMPACT_SUGGEST_TOKENS = 100_000;
const CONTEXT_MAX_TOKENS = 200_000;

function Drop<T extends string>({
  label, value, options, open, onToggle, onPick, minWidth = 78, showLabel = true,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  open: boolean;
  onToggle: () => void;
  onPick: (id: T) => void;
  minWidth?: number;
  showLabel?: boolean; // off when the cluster tag already names the field
}) {
  const cur = options.find((o) => o.id === value) ?? options[0];
  const btn: CSSProperties = {
    appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
    background: "color-mix(in srgb, var(--panel2) 60%, transparent)", color: "var(--txh)", fontFamily: "inherit",
    fontSize: 9.5, letterSpacing: ".3px", padding: "4px 9px", display: "flex",
    alignItems: "center", gap: 10, justifyContent: "space-between", minWidth,
  };
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      {showLabel && (
        <span className="ctrl-label" style={{ fontSize: 8, letterSpacing: 1, color: "var(--txl)", flex: "none" }}>{label}</span>
      )}
      <button onClick={onToggle} title={`${label} — ${cur.label}`} style={btn}>
        {cur.label}
        <span style={{ color: "var(--txd)", fontSize: 8 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", bottom: "calc(100% + 5px)", left: 0, minWidth: 132,
            zIndex: 30, border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
            boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
          }}
        >
          {options.map((o) => {
            const on = o.id === value;
            return (
              <button
                key={o.id}
                onClick={() => onPick(o.id)}
                style={{
                  width: "100%", appearance: "none", cursor: "pointer", border: 0,
                  borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
                  background: on ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
                  color: on ? "var(--txb)" : "var(--txm)", fontFamily: "inherit", fontSize: 10.5,
                  letterSpacing: ".3px", textAlign: "left", padding: "8px 11px",
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                <span style={{ width: 8, color: "var(--acc)", flex: "none" }}>{on ? "✓" : ""}</span>
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

// Shared look for the small action chips (REVIEW / AUDIT / MAP, and COMPACT on the context line).
const chip: CSSProperties = {
  appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
  background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 9,
  letterSpacing: 1, padding: "3px 8px",
};

// Shared look for the command-line action buttons (STOP / STEER / QUEUE / SEND).
const actBtn: CSSProperties = {
  appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 11, letterSpacing: 2,
  padding: "6px 14px", flex: "none", display: "inline-flex", alignItems: "center", gap: 6,
};

// Steering folds text into the turn already in flight. Merge rotated a quarter
// turn: two strands come in from the left and leave as one, pointing forward.
export function SteerIcon({ size = 13 }: { size?: number }) {
  return <Merge size={size} strokeWidth={1.8} style={{ transform: "rotate(90deg)", flex: "none" }} aria-hidden />;
}

export function Composer({
  disabled, running, model, models, effort, perm, onPerm, ponytail, onPonytail, injectedText, injectNonce, sessionId,
  draft, onDraft, contextTokens, onModel, onEffort, onSend, onSteer, onStop, onCompact,
  queued, onCancelQueued, project, onOpenMap,
}: {
  disabled: boolean;
  running: boolean;
  // What you've typed, owned by the session it's for — switching sessions swaps
  // the text rather than carrying it into the next one.
  draft: string;
  onDraft: (text: string) => void;
  project?: string | null;
  onOpenMap?: () => void;
  model: ModelId;
  models: { id: ModelId; label: string }[];
  effort: EffortLevel | "";
  perm: string;
  onPerm: (p: string) => void;
  ponytail: string;
  onPonytail: (v: string) => void;
  injectedText?: string;
  injectNonce?: number;
  sessionId?: string | null;
  contextTokens?: number;
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  onSend: (text: string, images: string[]) => void;
  onSteer?: (text: string) => void;
  onStop: () => void;
  onCompact?: () => void;
  queued?: { id: string; text: string }[];
  onCancelQueued?: (id: string) => void;
}) {
  const text = draft;
  const setText = onDraft;
  const [images, setImages] = useState<string[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [openDrop, setOpenDrop] = useState<"" | "model" | "effort" | "mode" | "pony">("");
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (injectNonce) {
      setText(injectedText ?? "");
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectNonce]);

  // Focus the command line whenever a session is opened or switched (and on
  // first mount) so you can start typing immediately without clicking in.
  useEffect(() => {
    taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Project map freshness for the MAP button. Re-read when the project changes
  // and when a turn ends — that's when the bridge rebuilds the graph — then
  // follow the build so the age lands on the new map, not the one it replaced.
  const [graph, setGraph] = useState<GraphState | null>(null);
  useEffect(() => {
    if (!project) { setGraph(null); return; }
    let live = true;
    let t = 0;
    const poll = () => api.graphState(project)
      .then((s) => {
        if (!live) return;
        setGraph(s);
        if (s.building) t = window.setTimeout(poll, 3000);
      })
      .catch(() => { if (live) setGraph(null); });
    void poll();
    return () => { live = false; if (t) window.clearTimeout(t); };
  }, [project, running]);

  // Auto-grow the input with its content (1 line → up to ~9 lines, then scroll).
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    Array.from(files).forEach((f) => {
      const r = new FileReader();
      r.onload = () => setImages((prev) => [...prev, r.result as string]);
      r.readAsDataURL(f);
    });
  }
  function imagesFrom(items: DataTransferItemList | undefined): File[] {
    return Array.from(items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
  }
  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, images);
    setText("");
    setImages([]);
  }

  // Land the text in the turn that's already running. Images can't fold into a
  // live turn, so they stay in the tray for the next send.
  function steer() {
    const t = text.trim();
    if (!t || !onSteer) return;
    onSteer(t);
    setText("");
  }

  const ctx = contextTokens ?? 0;
  const ctxPct = Math.min(100, Math.round((ctx / CONTEXT_MAX_TOKENS) * 100));
  const suggest = ctx >= COMPACT_SUGGEST_TOKENS;

  return (
    <div style={{ flex: "none", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", padding: "11px 16px" }}>
      {/* queued prompts — waiting to run after the current turn */}
      {queued && queued.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 9 }}>
          <span style={{ fontSize: 10, letterSpacing: 1, color: "var(--purple)", flex: "none" }}>QUEUED · {queued.length}</span>
          {queued.map((q) => (
            <span key={q.id} title={q.text}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 240, border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontSize: 10, letterSpacing: 0.5, padding: "2px 6px" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
              {onCancelQueued && (
                <button onClick={() => onCancelQueued(q.id)} title="Remove from queue"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: 11, lineHeight: 1, padding: 0, flex: "none" }}>✕</button>
              )}
            </span>
          ))}
        </div>
      )}
      {/* context meter — full-width status line above the controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, letterSpacing: 1, color: "var(--txl)", marginBottom: 10 }}>
        CONTEXT
        <span style={{ flex: 1, height: 4, background: "color-mix(in srgb, var(--acc) 12%, transparent)", position: "relative", overflow: "hidden" }}>
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${ctxPct}%`, background: "linear-gradient(90deg,var(--acc),var(--purple))", transition: "width .4s ease" }} />
        </span>
        <span style={{ color: suggest ? "var(--warn)" : "var(--acc)", flex: "none" }}>{ctxPct}%</span>
        {ctx > 0 && <span style={{ flex: "none" }}>~{fmtTokens(ctx)}</span>}
        {onCompact && (
          <button onClick={() => onCompact()} disabled={disabled || running} title="Compact context (/compact)"
            style={{ ...chip, flex: "none", cursor: disabled || running ? "not-allowed" : "pointer", opacity: disabled || running ? 0.4 : 1, ...(suggest ? { border: "1px solid var(--warn)", color: "var(--warn)" } : null) }}>
            COMPACT
          </button>
        )}
      </div>

      {/* image attachments */}
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
      {images.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 9 }}>
          {images.map((src, i) => (
            <div key={i} style={{ position: "relative", width: 48, height: 48 }}>
              <ZoomButton onOpen={() => setZoom(src)}>
                <img src={src} alt="" style={{ width: 48, height: 48, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", objectFit: "cover" }} />
              </ZoomButton>
              <button
                type="button"
                onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                aria-label="Remove image"
                style={{ position: "absolute", right: -6, top: -6, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "var(--panel3)", color: "var(--txd)", fontSize: 11, lineHeight: 1, cursor: "pointer" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* session controls — three fenced clusters: what runs the turn (AI), how
          much code it writes (PONYTAIL, with its two review commands), and the
          project map (GRAPH). Layout ladder lives in index.css. */}
      {openDrop && <div onClick={() => setOpenDrop("")} style={{ position: "fixed", inset: 0, zIndex: 25 }} />}
      <div className="ctrl-cq" style={{ marginBottom: 9, position: "relative", zIndex: 26 }}>
        <div className="ctrl-row">
          <div className="ctrl-group">
            <span className="ctrl-tag">AI</span>
            <Drop label="MODEL" value={model} options={models} open={openDrop === "model"}
              onToggle={() => setOpenDrop((d) => (d === "model" ? "" : "model"))}
              onPick={(id) => { onModel(id); setOpenDrop(""); }} />
            <Drop label="EFFORT" value={effort} options={EFFORTS} open={openDrop === "effort"}
              onToggle={() => setOpenDrop((d) => (d === "effort" ? "" : "effort"))}
              onPick={(id) => { onEffort(id); setOpenDrop(""); }} />
            <Drop label="MODE" value={perm} options={PERMS} open={openDrop === "mode"} minWidth={104}
              onToggle={() => setOpenDrop((d) => (d === "mode" ? "" : "mode"))}
              onPick={(id) => { onPerm(id); setOpenDrop(""); }} />
          </div>
          <div className="ctrl-group">
            <span className="ctrl-tag">PONYTAIL</span>
            <Drop label="PONYTAIL" showLabel={false} value={ponytail} options={PONYTAILS} open={openDrop === "pony"}
              onToggle={() => setOpenDrop((d) => (d === "pony" ? "" : "pony"))}
              onPick={(id) => { onPonytail(id); setOpenDrop(""); }} />
            {/* ponytail: native title tooltip, no popover component */}
            <button type="button" aria-label="About ponytail"
              title={"PONYTAIL — code-minimalism for this session's runs.\n\nClaude answers as a lazy senior dev: reuse what's already in the repo, stdlib or native platform before a new dependency, shortest diff that works, no speculative abstractions.\n\nOff = normal. Lite → Full → Ultra = increasing pressure to write less code. Default keeps whatever the bridge is configured with."}
              style={{ ...chip, flex: "none", cursor: "help", padding: "3px 6px", marginLeft: -5 }}>ⓘ</button>
            <button onClick={() => onSend("/ponytail-review", [])} disabled={disabled} title="ponytail review of the working tree"
              style={{ ...chip, flex: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}>
              REVIEW
            </button>
            <button onClick={() => onSend("/ponytail-audit", [])} disabled={disabled} title="ponytail repo audit"
              style={{ ...chip, flex: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}>
              AUDIT
            </button>
          </div>
          {onOpenMap && graph?.available && (
            <div className="ctrl-group">
              <span className="ctrl-tag">GRAPH</span>
              <button onClick={onOpenMap}
                title={graph.building
                  ? "Learning your project for better and faster responses. Opens the MAP tab."
                  : graph.exists
                  ? `Project map — built ${ago(graph.built_at)} ago${graph.stale ? ", stale" : ""}. Opens the MAP tab.`
                  : "No project map yet — it builds itself after the first turn. Opens the MAP tab."}
                style={{ ...chip, flex: "none", display: "flex", alignItems: "center", gap: 6, ...(graph.building ? { border: "1px solid var(--acc)", color: "var(--acc)" } : null) }}>
                MAP
                <span style={{ color: graph.stale && !graph.building ? "var(--warn)" : "inherit" }}>
                  {graph.building ? "LEARNING…" : graph.exists ? ago(graph.built_at) : "—"}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* command line */}
      <div
        style={{ display: "flex", alignItems: "flex-start", gap: 11, border: `1px solid ${dragging ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, background: "color-mix(in srgb, var(--panel2) 70%, transparent)", padding: "10px 13px", fontFamily: "'JetBrains Mono',monospace" }}
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (imgs.length) addFiles(imgs);
        }}
      >
        <span style={{ color: "var(--purple)", fontSize: 13, flex: "none", marginTop: 2 }}>~ ❯</span>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          onPaste={(e) => { const imgs = imagesFrom(e.clipboardData?.items); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
          placeholder={disabled ? "working…" : running ? "queue a prompt — runs after the current turn…" : "message claude — describe a change, paste an error…"}
          rows={1}
          style={{ flex: 1, minWidth: 0, display: "block", maxHeight: 180, overflowY: "auto", resize: "none", background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, lineHeight: 1.5 }}
        />
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} title="Attach image"
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", display: "flex", flex: "none", marginTop: 3 }}>
          <Paperclip size={14} strokeWidth={1.8} aria-hidden /></button>
        {running ? (
          <>
            <button onClick={onStop}
              style={{ ...actBtn, border: "1px solid var(--err)", background: "color-mix(in srgb, var(--err) 12%, transparent)", color: "var(--err)" }}>
              STOP <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden /></button>
            {onSteer && (
              <button onClick={steer} disabled={!text.trim()} title="Fold this into the turn that's running now (text only — falls back to queueing if the run just ended)"
                style={{ ...actBtn, cursor: !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--warn)", background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)", opacity: !text.trim() ? 0.4 : 1 }}>
                STEER <SteerIcon /></button>
            )}
            <button onClick={submit} disabled={disabled || !text.trim()} title="Queue this prompt to run after the current turn"
              style={{ ...actBtn, cursor: disabled || !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 12%, transparent)", color: "var(--purple-b)", opacity: disabled || !text.trim() ? 0.4 : 1 }}>
              QUEUE <ChevronsRight size={13} strokeWidth={1.8} aria-hidden /></button>
          </>
        ) : (
          <button onClick={submit} disabled={disabled || !text.trim()}
            style={{ ...actBtn, cursor: disabled || !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--acc)", background: "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", opacity: disabled || !text.trim() ? 0.4 : 1 }}>
            SEND <ChevronRight size={13} strokeWidth={1.8} aria-hidden /></button>
        )}
      </div>
    </div>
  );
}
