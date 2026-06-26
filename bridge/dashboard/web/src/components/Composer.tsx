import { useEffect, useRef, useState } from "react";
import type { EffortLevel, ModelId } from "../api";
import { ContextStrip } from "./UsageStrip";

const MODELS: ModelId[] = ["opus", "sonnet", "haiku"];
const EFFORTS: (EffortLevel | "")[] = ["", "low", "medium", "high", "xhigh", "max"];
// Per-message operating mode ("" keeps the session's). Mirrors the CLI permission
// modes so you can flip a single run (ask / plan / full autonomy) remotely.
const PERMS: { id: string; label: string }[] = [
  { id: "", label: "MODE: SESSION" },
  { id: "default", label: "ASK EACH TIME" },
  { id: "acceptEdits", label: "ACCEPT EDITS" },
  { id: "plan", label: "PLAN ONLY" },
  { id: "auto", label: "AUTO" },
  { id: "bypassPermissions", label: "FULL AUTONOMY" },
];

// Past this estimated context size we nudge the user toward /compact.
const COMPACT_SUGGEST_TOKENS = 100_000;

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

export function Composer({
  disabled,
  running,
  model,
  effort,
  permissionMode,
  perm,
  onPerm,
  injectedText,
  injectNonce,
  contextTokens,
  onModel,
  onEffort,
  onSend,
  onStop,
  onCompact,
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
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  onCompact?: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Prefill the composer when something feeds it a prompt (e.g. an issue). The
  // nonce retriggers even if the same text is fed twice.
  useEffect(() => {
    if (injectNonce) setText(injectedText ?? "");
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
  function removeImage(i: number) {
    setImages((prev) => prev.filter((_, j) => j !== i));
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

  return (
    <div className="flex-none border-t border-border px-4 py-3">
      <ContextStrip permissionMode={permissionMode} />
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={i} className="relative h-12 w-12">
              <img src={src} className="h-12 w-12 border border-border object-cover" alt="" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                title="Remove image"
                aria-label="Remove image"
                className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center border border-border-bright bg-background text-[11px] leading-none text-muted-foreground hover:border-danger hover:text-danger"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`border bg-[rgba(7,13,13,.7)] px-3 py-2.5 ${dragging ? "border-primary" : "border-input"}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (imgs.length) addFiles(imgs);
        }}
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex-none text-[13px] text-violet">~ ❯</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const imgs = imagesFrom(e.clipboardData?.items);
              if (imgs.length) {
                e.preventDefault();
                addFiles(imgs);
              }
            }}
            placeholder={disabled ? "working…" : "message claude — describe a change, paste an error, or run a command…"}
            rows={2}
            className="max-h-40 w-full resize-none bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:text-[#456b65]"
          />
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => onModel(e.target.value as ModelId)}
            className="border border-input bg-transparent px-2 py-1 text-[11px] tracking-[1px] text-muted-foreground"
          >
            {MODELS.map((m) => (
              <option key={m} value={m} className="bg-[#0b1313] text-foreground">
                {m.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            value={effort}
            onChange={(e) => onEffort(e.target.value as EffortLevel | "")}
            className="border border-input bg-transparent px-2 py-1 text-[11px] tracking-[1px] text-muted-foreground"
          >
            {EFFORTS.map((e) => (
              <option key={e} value={e} className="bg-[#0b1313] text-foreground">
                {e ? e.toUpperCase() : "EFFORT: AUTO"}
              </option>
            ))}
          </select>
          <select
            value={perm}
            onChange={(e) => onPerm(e.target.value)}
            title="Operating mode for the next message"
            className="border border-input bg-transparent px-2 py-1 text-[11px] tracking-[1px] text-muted-foreground"
          >
            {PERMS.map((p) => (
              <option key={p.id} value={p.id} className="bg-[#0b1313] text-foreground">
                {p.label}
              </option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="px-1 text-[14px] text-muted-2 hover:text-foreground"
            onClick={() => fileRef.current?.click()}
            title="Attach image"
          >
            📎
          </button>
          {onCompact &&
            (() => {
              const ctx = contextTokens ?? 0;
              const suggest = ctx >= COMPACT_SUGGEST_TOKENS;
              return (
                <div className="flex items-center gap-2">
                  {ctx > 0 && (
                    <span
                      title="Estimated conversation context (~chars/4)"
                      className={`hidden text-[10px] tracking-[1px] sm:inline ${
                        suggest ? "text-warning" : "text-muted-2"
                      }`}
                    >
                      ~{fmtTokens(ctx)} ctx{suggest ? " · large" : ""}
                    </span>
                  )}
                  <button
                    onClick={() => onCompact()}
                    disabled={disabled}
                    title={
                      suggest
                        ? `Context is large (~${fmtTokens(ctx)} tokens) — consider compacting (/compact)`
                        : "Compact context (/compact)"
                    }
                    className={`border px-2 py-1 text-[10px] tracking-[1px] hover:text-foreground disabled:opacity-40 ${
                      suggest
                        ? "border-warning text-warning"
                        : "border-input text-muted-foreground"
                    }`}
                  >
                    COMPACT
                  </button>
                </div>
              );
            })()}
          <div className="flex-1" />
          {running ? (
            <button
              className="border border-danger bg-[rgba(224,137,122,.12)] px-4 py-1.5 text-[11px] tracking-[2px] text-danger hover:bg-[rgba(224,137,122,.22)]"
              onClick={onStop}
            >
              STOP ■
            </button>
          ) : (
            <button
              disabled={disabled || !text.trim()}
              onClick={submit}
              className="border border-primary bg-[var(--ac-12)] px-4 py-1.5 text-[11px] tracking-[2px] text-foreground-bright hover:bg-[var(--ac-22)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              SEND ▸
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
