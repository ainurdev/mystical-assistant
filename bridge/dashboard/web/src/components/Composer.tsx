import { useEffect, useRef, useState, type CSSProperties } from "react";
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
    appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)",
    background: "rgba(7,13,13,.6)", color: "#cfe9e3", fontFamily: "inherit",
    fontSize: 9.5, letterSpacing: ".3px", padding: "4px 9px", display: "flex",
    alignItems: "center", gap: 10, justifyContent: "space-between", minWidth,
  };
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 8, letterSpacing: 1, color: "#3c544f", flex: "none" }}>{label}</span>
      <button onClick={onToggle} style={btn}>
        {cur.label}
        <span style={{ color: "#6f938d", fontSize: 8 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", bottom: "calc(100% + 5px)", left: 0, minWidth: 132,
            zIndex: 30, border: "1px solid rgba(127,233,216,.35)", background: "rgba(7,13,13,.98)",
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
                  borderBottom: "1px solid rgba(127,233,216,.08)",
                  background: on ? "rgba(127,233,216,.1)" : "transparent",
                  color: on ? "#dff8f2" : "#9fc7c0", fontFamily: "inherit", fontSize: 10.5,
                  letterSpacing: ".3px", textAlign: "left", padding: "8px 11px",
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                <span style={{ width: 8, color: "#7fe9d8", flex: "none" }}>{on ? "✓" : ""}</span>
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
  disabled, running, model, effort, perm, onPerm, injectedText, injectNonce,
  contextTokens, resetLabel, onModel, onEffort, onSend, onStop, onCompact,
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
  contextTokens?: number;
  resetLabel?: string;
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  onCompact?: () => void;
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
    <div style={{ flex: "none", borderTop: "1px solid rgba(127,233,216,.14)", padding: "11px 16px" }}>
      {/* context + reset row */}
      <div style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 10, letterSpacing: 1, color: "#3c544f", marginBottom: 9 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
          CONTEXT
          <span style={{ flex: 1, maxWidth: 180, height: 4, background: "rgba(127,233,216,.12)", position: "relative", overflow: "hidden" }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${ctxPct}%`, background: "linear-gradient(90deg,#7fe9d8,#b9a6ff)", transition: "width .4s ease" }} />
          </span>
          <span style={{ color: suggest ? "#e3c279" : "#7fe9d8" }}>{ctxPct}%</span>
          {ctx > 0 && (
            <span style={{ color: "#3c544f" }}>~{fmtTokens(ctx)}</span>
          )}
        </span>
        {onCompact && (
          <button
            onClick={() => onCompact()}
            disabled={disabled}
            title="Compact context (/compact)"
            style={{
              appearance: "none", cursor: "pointer", background: "transparent",
              border: `1px solid ${suggest ? "#e3c279" : "rgba(127,233,216,.2)"}`,
              color: suggest ? "#e3c279" : "#6f938d", fontFamily: "inherit", fontSize: 9,
              letterSpacing: 1, padding: "3px 8px", opacity: disabled ? 0.4 : 1,
            }}
          >
            COMPACT
          </button>
        )}
        {resetLabel && <span>RESET <span style={{ color: "#bfe6de" }}>{resetLabel}</span></span>}
      </div>

      {/* image attachments */}
      {images.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 9 }}>
          {images.map((src, i) => (
            <div key={i} style={{ position: "relative", width: 48, height: 48 }}>
              <img src={src} alt="" style={{ width: 48, height: 48, border: "1px solid rgba(127,233,216,.16)", objectFit: "cover" }} />
              <button
                type="button"
                onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                aria-label="Remove image"
                style={{ position: "absolute", right: -6, top: -6, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(127,233,216,.4)", background: "#060a0a", color: "#6f938d", fontSize: 11, lineHeight: 1, cursor: "pointer" }}
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
        style={{ display: "flex", alignItems: "flex-start", gap: 11, border: `1px solid ${dragging ? "#7fe9d8" : "rgba(127,233,216,.18)"}`, background: "rgba(7,13,13,.7)", padding: "10px 13px", fontFamily: "'JetBrains Mono',monospace" }}
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (imgs.length) addFiles(imgs);
        }}
      >
        <span style={{ color: "#b9a6ff", fontSize: 13, flex: "none", marginTop: 2 }}>~ ❯</span>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          onPaste={(e) => { const imgs = imagesFrom(e.clipboardData?.items); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
          placeholder={disabled ? "working…" : "message claude — describe a change, paste an error…"}
          rows={1}
          style={{ flex: 1, minWidth: 0, maxHeight: 160, resize: "none", background: "transparent", border: 0, outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, lineHeight: 1.5 }}
        />
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} title="Attach image"
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "#6f938d", fontSize: 13, flex: "none", marginTop: 2 }}>📎</button>
        <span style={{ fontSize: 10, letterSpacing: 1, color: "#6f938d", border: "1px solid rgba(127,233,216,.2)", padding: "2px 8px", flex: "none", marginTop: 1 }}>{model.toUpperCase()}</span>
        {running ? (
          <button onClick={onStop}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid #e0897a", background: "rgba(224,137,122,.12)", color: "#e0897a", fontFamily: "inherit", fontSize: 11, letterSpacing: 2, padding: "6px 16px", flex: "none" }}>STOP ■</button>
        ) : (
          <button onClick={submit} disabled={disabled || !text.trim()}
            style={{ appearance: "none", cursor: disabled || !text.trim() ? "not-allowed" : "pointer", border: "1px solid #7fe9d8", background: "rgba(127,233,216,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 11, letterSpacing: 2, padding: "6px 16px", flex: "none", opacity: disabled || !text.trim() ? 0.4 : 1 }}>SEND ▸</button>
        )}
      </div>
    </div>
  );
}
