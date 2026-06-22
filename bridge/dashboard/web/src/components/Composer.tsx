import { useRef, useState } from "react";
import type { EffortLevel, ModelId } from "../api";
import { UsageStrip } from "./UsageStrip";

const MODELS: ModelId[] = ["opus", "sonnet", "haiku"];
const EFFORTS: (EffortLevel | "")[] = ["", "low", "medium", "high", "xhigh", "max"];

export function Composer({
  disabled,
  running,
  model,
  effort,
  onModel,
  onEffort,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  model: ModelId;
  effort: EffortLevel | "";
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
    <div className="border-t border-zinc-800 bg-zinc-900/60 p-3">
      <UsageStrip />
      {images.length > 0 && (
        <div className="mb-2 flex gap-2">
          {images.map((src, i) => (
            <img key={i} src={src} className="h-12 w-12 rounded object-cover" alt="" />
          ))}
        </div>
      )}
      <div className="mb-2 flex items-center gap-2 text-xs">
        <select
          value={model}
          onChange={(e) => onModel(e.target.value as ModelId)}
          className="rounded bg-zinc-800 px-2 py-1"
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
          className="rounded bg-zinc-800 px-2 py-1"
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
          className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700"
          onClick={() => fileRef.current?.click()}
        >
          📎
        </button>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "Working…" : "Message Claude…"}
          rows={2}
          className="max-h-40 flex-1 resize-none rounded-lg bg-zinc-800 px-3 py-2 text-sm outline-none placeholder:text-zinc-500"
        />
        {running ? (
          <button
            className="rounded-lg bg-red-600 px-4 py-2 text-sm hover:bg-red-500"
            onClick={onStop}
          >
            Stop
          </button>
        ) : (
          <button
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            disabled={disabled || !text.trim()}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
