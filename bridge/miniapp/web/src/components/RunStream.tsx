import type { RunEvent } from "../lib/api";

// Map a few common tool names to icons; default to a wrench.
function toolIcon(name: string): string {
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
      return "✏️";
    case "Read":
      return "📖";
    case "Bash":
      return "🔧";
    case "Grep":
    case "Glob":
      return "🔎";
    default:
      return "🔧";
  }
}

function EventRow({ event }: { event: RunEvent }) {
  switch (event.type) {
    case "text":
      return (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {event.text}
        </div>
      );
    case "tool":
      return (
        <div className="font-mono text-xs text-[var(--tg-hint)]">
          {toolIcon(event.name)} {event.name}
          {event.summary ? `: ${event.summary}` : ""}
        </div>
      );
    case "tool_done":
      return null;
    case "result":
      return null; // Final result is rendered separately by the parent.
    case "error":
      return (
        <div className="rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300">
          ⚠️ {event.message}
        </div>
      );
  }
}

export function RunStream({ events }: { events: RunEvent[] }) {
  return (
    <div className="space-y-2">
      {events.map((event, i) => (
        <EventRow key={i} event={event} />
      ))}
    </div>
  );
}
