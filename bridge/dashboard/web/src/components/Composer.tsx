import { useRef, useState } from "react";
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
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach((f) => {
      const r = new FileReader();
      r.onload = () => setImages((prev) => [...prev, r.result as string]);
      r.readAsDataURL(f);
    });
  }
  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, images);
    setText("");
    setImages([]);
  }

  return (
    <div className="shrink-0 border-t border-[#1c1828] px-6 pb-[18px] pt-3.5">
      <div className="mx-auto max-w-[760px]">
        <ContextStrip permissionMode={permissionMode} />
        {images.length > 0 && (
          <div className="mb-2 flex gap-2">
            {images.map((src, i) => (
              <img key={i} src={src} className="h-12 w-12 rounded object-cover" alt="" />
            ))}
          </div>
        )}
        <div className="rounded-[14px] border border-input bg-[#161220] p-3.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={disabled ? "Working…" : "Message Claude — describe a change, paste an error, or run a command…"}
            rows={2}
            className="max-h-40 w-full resize-none bg-transparent text-[13.5px] outline-none placeholder:text-[#5a5470]"
          />
          <div className="mt-3 flex items-center gap-2">
            <select
              value={model}
              onChange={(e) => onModel(e.target.value as ModelId)}
              className="rounded-lg border border-input bg-secondary px-2.5 py-1 text-xs text-foreground"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={effort}
              onChange={(e) => onEffort(e.target.value as EffortLevel | "")}
              className="rounded-lg border border-input bg-secondary px-2.5 py-1 text-xs text-foreground"
            >
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e || "effort: default"}
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
              className="px-1 text-[15px] text-muted-2 hover:text-foreground"
              onClick={() => fileRef.current?.click()}
              title="Attach image"
            >
              📎
            </button>
            <div className="flex-1" />
            {running ? (
              <button
                className="rounded-[9px] bg-red-600 px-5 py-2 text-[13px] font-semibold text-white hover:bg-red-500"
                onClick={onStop}
              >
                Stop
              </button>
            ) : (
              <button
                disabled={disabled || !text.trim()}
                onClick={submit}
                className="rounded-[9px] border border-brand-soft bg-primary px-5 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
