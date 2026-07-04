import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { EffortLevel, ModelId } from "../api";

const MODELS: { id: ModelId; label: string }[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
const EFFORTS: { id: EffortLevel | ""; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];
// Per-message operating mode ("" keeps the session's). Mirrors the CLI permission
// modes so you can flip a single run (ask / plan / full autonomy) remotely.
const PERMS: { id: string; label: string }[] = [
  { id: "", label: "Session" },
  { id: "default", label: "Ask" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto-run" },
  { id: "bypassPermissions", label: "Full Auto" },
];

const COMPACT_SUGGEST_TOKENS = 100_000;
const CONTEXT_MAX_TOKENS = 200_000;

function Drop<T extends string>({
  label, value, options, open, onToggle, onPick, minWidth = 78,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  open: boolean;
  onToggle: () => void;
  onPick: (id: T) => void;
  minWidth?: number;
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
      <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--txl)", flex: "none" }}>{label}</span>
      <button onClick={onToggle} style={btn}>
        {cur.label}
        <span style={{ color: "var(--txd)", fontSize: 8 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", bottom: "calc(100% + 5px)", left: 0, minWidth: 132,
            zIndex: 30, border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
            boxShadow: "0 -8px 26px rgba(0,0,0,.65)", animation: "mpop .12s ease",
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

export function Composer({
  disabled, running, model, effort, perm, onPerm, injectedText, injectNonce, sessionId,
  contextTokens, resetLabel, onModel, onEffort, onSend, onStop, onCompact,
  queued, onCancelQueued,
}: {
  disabled: boolean;
  running: boolean;
  model: ModelId;
  effort: EffortLevel | "";
  permissionMode?: string | null;
  perm: string;
  onPerm: (p: string) => void;
  injectedText?: string;
  injectNonce?: number;
  sessionId?: string | null;
  contextTokens?: number;
  resetLabel?: string;
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  onCompact?: () => void;
  queued?: { id: string; text: string }[];
  onCancelQueued?: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [openDrop, setOpenDrop] = useState<"" | "model" | "effort" | "mode">("");
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
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "#a38fe0", fontSize: 11, lineHeight: 1, padding: 0, flex: "none" }}>✕</button>
              )}
            </span>
          ))}
        </div>
      )}
      {/* context + reset row */}
      <div style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 10, letterSpacing: 1, color: "var(--txl)", marginBottom: 9 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
          CONTEXT
          <span style={{ flex: 1, maxWidth: 180, height: 4, background: "color-mix(in srgb, var(--acc) 12%, transparent)", position: "relative", overflow: "hidden" }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${ctxPct}%`, background: "linear-gradient(90deg,var(--acc),var(--purple))", transition: "width .4s ease" }} />
          </span>
          <span style={{ color: suggest ? "var(--warn)" : "var(--acc)" }}>{ctxPct}%</span>
          {ctx > 0 && (
            <span style={{ color: "var(--txl)" }}>~{fmtTokens(ctx)}</span>
          )}
        </span>
        {onCompact && (
          <button
            onClick={() => onCompact()}
            disabled={disabled || running}
            title="Compact context (/compact)"
            style={{
              appearance: "none", cursor: "pointer", background: "transparent",
              border: `1px solid ${suggest ? "var(--warn)" : "color-mix(in srgb, var(--acc) 20%, transparent)"}`,
              color: suggest ? "var(--warn)" : "var(--txd)", fontFamily: "inherit", fontSize: 9,
              letterSpacing: 1, padding: "3px 8px", opacity: disabled || running ? 0.4 : 1,
            }}
          >
            COMPACT
          </button>
        )}
        {resetLabel && <span>RESET <span style={{ color: "var(--tx)" }}>{resetLabel}</span></span>}
      </div>

      {/* image attachments */}
      {images.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 9 }}>
          {images.map((src, i) => (
            <div key={i} style={{ position: "relative", width: 48, height: 48 }}>
              <img src={src} alt="" style={{ width: 48, height: 48, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", objectFit: "cover" }} />
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

      {/* model / effort / mode dropdowns */}
      {openDrop && <div onClick={() => setOpenDrop("")} style={{ position: "fixed", inset: 0, zIndex: 25 }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 9, position: "relative", zIndex: 26 }}>
        <Drop label="MODEL" value={model} options={MODELS} open={openDrop === "model"}
          onToggle={() => setOpenDrop((d) => (d === "model" ? "" : "model"))}
          onPick={(id) => { onModel(id); setOpenDrop(""); }} />
        <Drop label="EFFORT" value={effort} options={EFFORTS} open={openDrop === "effort"}
          onToggle={() => setOpenDrop((d) => (d === "effort" ? "" : "effort"))}
          onPick={(id) => { onEffort(id); setOpenDrop(""); }} />
        <Drop label="MODE" value={perm} options={PERMS} open={openDrop === "mode"} minWidth={104}
          onToggle={() => setOpenDrop((d) => (d === "mode" ? "" : "mode"))}
          onPick={(id) => { onPerm(id); setOpenDrop(""); }} />
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
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", fontSize: 13, flex: "none", marginTop: 2 }}>📎</button>
        <span style={{ fontSize: 10, letterSpacing: 1, color: "var(--txd)", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", padding: "2px 8px", flex: "none", marginTop: 1 }}>{model.toUpperCase()}</span>
        {running ? (
          <>
            <button onClick={onStop}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--err)", background: "color-mix(in srgb, var(--err) 12%, transparent)", color: "var(--err)", fontFamily: "inherit", fontSize: 11, letterSpacing: 2, padding: "6px 16px", flex: "none" }}>STOP ■</button>
            <button onClick={submit} disabled={disabled || !text.trim()} title="Queue this prompt to run after the current turn"
              style={{ appearance: "none", cursor: disabled || !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 12%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: 11, letterSpacing: 2, padding: "6px 16px", flex: "none", opacity: disabled || !text.trim() ? 0.4 : 1 }}>QUEUE ▸</button>
          </>
        ) : (
          <button onClick={submit} disabled={disabled || !text.trim()}
            style={{ appearance: "none", cursor: disabled || !text.trim() ? "not-allowed" : "pointer", border: "1px solid var(--acc)", background: "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 11, letterSpacing: 2, padding: "6px 16px", flex: "none", opacity: disabled || !text.trim() ? 0.4 : 1 }}>SEND ▸</button>
        )}
      </div>
    </div>
  );
}
