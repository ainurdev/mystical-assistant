import { useEffect, useRef, useState } from "react";
import type { EffortLevel, ModelId } from "../api";
import { ContextStrip } from "./UsageStrip";

const MODELS: ModelId[] = ["opus", "sonnet", "haiku"];
const EFFORTS: (EffortLevel | "")[] = ["", "low", "medium", "high", "xhigh", "max"];

export function Composer({
  disabled,
  running,
  model,
  effort,
  permissionMode,
  injectedText,
  injectNonce,
  onModel,
  onEffort,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  model: ModelId;
  effort: EffortLevel | "";
  permissionMode?: string | null;
  injectedText?: string;
  injectNonce?: number;
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
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
        <div className="mb-2 flex gap-2">
          {images.map((src, i) => (
            <img key={i} src={src} className="h-12 w-12 border border-border object-cover" alt="" />
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
