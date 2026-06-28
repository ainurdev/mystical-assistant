import { useState, type RefObject } from "react";

const PRESETS = [
  { label: "Mobile", w: 375 },
  { label: "Tablet", w: 768 },
  { label: "Laptop", w: 1280 },
  { label: "Desktop", w: 1440 },
] as const;

export function PreviewFrame({
  url, iframeRef, width, onWidth, mode, onMode, hoverLabel,
}: {
  url: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  width: number;
  onWidth: (w: number) => void;
  mode: "idle" | "select" | "pin";
  onMode: (m: "idle" | "select" | "pin") => void;
  hoverLabel: string | null;
}) {
  const [containerW, setContainerW] = useState(0);
  const scale = containerW && width > containerW ? containerW / width : 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {PRESETS.map((p) => (
          <button key={p.w} onClick={() => onWidth(p.w)}
            className={`rounded-lg px-2.5 py-1.5 ${width === p.w ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]" : "bg-[var(--tg-secondary-bg)]"}`}>
            {p.label} <span className="opacity-60">{p.w}</span>
          </button>
        ))}
        <input type="number" value={width} onChange={(e) => onWidth(Number(e.target.value) || width)}
          className="w-20 rounded-lg bg-[var(--tg-secondary-bg)] px-2 py-1.5 outline-none" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <button onClick={() => onMode(mode === "select" ? "idle" : "select")}
          className={`rounded-lg px-4 py-2 font-medium ${mode === "select" ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]" : "bg-[var(--tg-secondary-bg)]"}`}>Select</button>
        <button onClick={() => onMode(mode === "pin" ? "idle" : "pin")}
          className={`rounded-lg px-4 py-2 font-medium ${mode === "pin" ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]" : "bg-[var(--tg-secondary-bg)]"}`}>Pin</button>
        {hoverLabel && <span className="ml-1 truncate font-mono text-[var(--tg-hint)]">{hoverLabel}</span>}
      </div>
      <div ref={(el) => setContainerW(el?.clientWidth ?? 0)}
        className="relative h-[60vh] overflow-auto rounded-lg bg-[var(--tg-bg)]">
        <div style={{ width, transform: `scale(${scale})`, transformOrigin: "top left", height: scale < 1 ? `${100 / scale}%` : "100%" }}>
          <iframe ref={iframeRef} src={url} title="preview"
            style={{ width: "100%", height: "100%", border: "0" }} />
        </div>
      </div>
    </div>
  );
}
