import { useEffect, useState } from "react";
import { Square } from "lucide-react";
import { useChat } from "../lib/chat";

/* RUN — the strip that stays put while a turn works, so the elapsed clock, the
   tool it is on and the stop button don't scroll away with the transcript. */

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function RunMonitor() {
  const { activeTurn, stop, model, models } = useChat();
  const [, tick] = useState(0);

  // One repaint a second while a turn runs — the clock is the only thing moving.
  useEffect(() => {
    if (!activeTurn) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [activeTurn]);

  if (!activeTurn) return null;
  const tools = activeTurn.events.filter((e) => e.type === "tool");
  const last = tools[tools.length - 1];
  const label =
    last && last.type === "tool"
      ? `${last.name}${last.summary ? `: ${last.summary}` : ""}`
      : "Thinking…";
  const modelLabel = (models.find((m) => m.id === model)?.label ?? model)
    .replace(/^Claude /, "")
    .toUpperCase();

  return (
    <div className="panel flex items-center gap-2.5 border border-amber-400/40 bg-[var(--card)] px-3 py-2">
      <span className="shrink-0 text-[9.5px] tracking-[2px] text-amber-400">
        RUN // {clock(Date.now() / 1000 - (activeTurn.started ?? Date.now() / 1000))}
        <span
          className="ml-1 inline-block h-2.5 w-1.5 align-[-1px] bg-amber-400"
          style={{ animation: "caret 1.1s steps(1) infinite" }}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] text-foreground-bright">{label}</span>
        <span className="block text-[9.5px] tracking-wider text-[var(--tg-hint)]">
          {tools.length} TOOL{tools.length === 1 ? "" : "S"} · {modelLabel}
        </span>
      </span>
      <button
        onClick={() => void stop()}
        aria-label="Stop"
        className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--danger)]/50 text-[var(--danger)] active:opacity-70"
      >
        <Square size={12} fill="currentColor" aria-hidden />
      </button>
    </div>
  );
}
