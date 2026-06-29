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
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {PRESETS.map((p) => (
          <button key={p.w} onClick={() => onWidth(p.w)}
            className={`rounded px-2 py-1 ${width === p.w ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-[var(--panel)]"}`}>
            {p.label} <span className="opacity-60">{p.w}</span>
          </button>
        ))}
        <input type="number" value={width} onChange={(e) => onWidth(Number(e.target.value) || width)}
          className="w-20 rounded bg-[var(--panel)] px-2 py-1" />
        <span className="mx-2 opacity-40">|</span>
        <button onClick={() => onMode(mode === "select" ? "idle" : "select")}
          className={`rounded px-2 py-1 ${mode === "select" ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-[var(--panel)]"}`}>Select</button>
        {hoverLabel && <span className="ml-2 truncate font-mono opacity-70">{hoverLabel}</span>}
      </div>
      <div ref={(el) => setContainerW(el?.clientWidth ?? 0)}
        className="relative flex-1 overflow-auto rounded border border-[var(--border)] bg-[var(--background)]"
        style={{ cursor: mode === "select" ? "crosshair" : "default" }}>
        <div style={{ width, transform: `scale(${scale})`, transformOrigin: "top left", height: scale < 1 ? `${100 / scale}%` : "100%" }}>
          <iframe ref={iframeRef} src={url} title="preview"
            style={{ width: "100%", height: "100%", border: "0" }} />
        </div>
      </div>
    </div>
  );
}
