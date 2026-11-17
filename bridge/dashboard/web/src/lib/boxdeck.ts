// The prompt box while a turn runs (B · DECK, .mystical/design-drafts/prompt-box-v2):
// queued prompts stack as a deck above the box, and a NOW|NEXT switch says what
// Enter does with the text — fold it into the running turn, or queue it after.
// Alt+Enter does the other one: Shift+Enter is already the editor's newline.

export type EnterMode = "now" | "next";

/** The deck's strips, in run order (the first is NEXT), and how many wait past the cap. */
export function deckView<T>(queued: T[], cap: number): { shown: T[]; more: number } {
  return { shown: queued.slice(0, cap), more: Math.max(0, queued.length - cap) };
}

/** Where Enter sends the text mid-turn. A turn that can't be steered always queues. */
export function enterTarget(mode: EnterMode, other: boolean, canSteer: boolean): "steer" | "queue" {
  if (!canSteer) return "queue";
  return (mode === "now") !== other ? "steer" : "queue";
}

/** A running turn's age: "42s", "3m 12s", "1h 04m". */
export function turnClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
