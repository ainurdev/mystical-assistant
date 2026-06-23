import { Search } from "lucide-react";
import type { DashState } from "../api";

const SURFACE_CHIPS: { code: string; color: string; title: string }[] = [
  { code: "TG", color: "var(--surface-tg)", title: "Telegram bot" },
  { code: "MA", color: "var(--surface-ma)", title: "Telegram Mini App" },
];

export function Header({
  projectName,
  view,
  onView,
  vscodeLive,
  state,
  onServer,
  onPreview,
}: {
  projectName: string;
  view: "chat" | "history";
  onView: (v: "chat" | "history") => void;
  vscodeLive: boolean;
  state: DashState | null;
  onServer: () => void;
  onPreview: () => void;
}) {
  const serverRunning = state?.server.status === "running";
  const previewUrl = state?.preview.url ?? null;
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-4 border-b border-panel-border bg-panel px-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-gradient-to-br from-brand-soft to-brand text-sm font-bold text-white shadow-[0_2px_8px_rgba(124,88,255,.4)]">
          m
        </div>
        <div className="font-semibold tracking-tight">{projectName || "mystical-assistant"}</div>
      </div>

      <div className="flex items-center gap-1.5 rounded-[7px] border border-border bg-muted px-2.5 py-1">
        <span className="h-[7px] w-[7px] rounded-full bg-success [animation:mpulse_2.2s_infinite]" />
        <span className="text-xs text-muted-foreground">bridge connected</span>
        <span className="font-mono text-xs text-muted-2">· {location.host}</span>
      </div>

      <div className="flex gap-0.5 rounded-lg border border-border bg-muted p-[3px]">
        {(["chat", "history"] as const).map((v) => (
          <button
            key={v}
            onClick={() => onView(v)}
            className={`rounded-md px-3.5 py-1 text-[13px] font-medium capitalize ${
              view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5">
        {SURFACE_CHIPS.map((c) => (
          <div
            key={c.code}
            title={c.title}
            className="flex items-center gap-1.5 rounded-[7px] border border-border bg-muted px-2.5 py-1.5"
          >
            <span className="font-mono text-[10px] font-medium tracking-wider" style={{ color: c.color }}>
              {c.code}
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
          </div>
        ))}
        <div
          title="VS Code on this machine"
          className="flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5"
          style={{
            background: vscodeLive ? "var(--surface-vs-bg)" : "var(--muted)",
            borderColor: vscodeLive ? "#3a2f6b" : "var(--border)",
          }}
        >
          <span className="font-mono text-[10px] font-medium tracking-wider" style={{ color: "var(--surface-vs)" }}>
            VS
          </span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${vscodeLive ? "bg-success [animation:mpulse_2.2s_infinite]" : "bg-muted-2"}`}
          />
        </div>
      </div>

      <div className="h-6 w-px bg-border" />

      <button
        title="Command palette (coming soon)"
        className="flex items-center gap-2.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent"
      >
        <Search size={13} aria-hidden />
        <span>Search &amp; commands</span>
        <span className="rounded-[5px] border border-input px-1.5 font-mono text-[11px] text-muted-2">⌘K</span>
      </button>

      <button
        onClick={onServer}
        className="rounded-lg border border-input bg-secondary px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-accent"
      >
        {serverRunning ? "Stop server" : "Start server"}
      </button>
      <button
        onClick={onPreview}
        className="rounded-lg border border-brand-soft bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
      >
        {previewUrl ? "Stop preview" : "Preview"}
      </button>
    </header>
  );
}
