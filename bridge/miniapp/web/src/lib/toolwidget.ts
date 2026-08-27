// Mirrors bridge/dashboard/web/src/lib/toolwidget.ts. Keep them in sync — the
// ONE difference is useToolStyle: the dashboard threads the setting down as a
// prop from its HudSettings object, the Mini App has no such object and reads
// it here.
import { usePersistentState } from "./persistentState.ts";

// What a finished tool hands the widget layer, and the frame that layer draws.
//
// The widgets came from typed flows, where a stage declared each field's type.
// Nothing declares a type any more, so the mapping lives here: a table from
// what `tool_done` actually carries (bridge/transcript_jsonl.py) to the widget
// that draws it. A tool with no entry keeps the one-line row it always had —
// which is the whole safety property. A wrong or missing mapping costs nothing.
//
// Measured before writing this: of 41,393 tool calls on this machine, Bash is
// 70%, edits 14%, Read 10%, the web tools 0.4%, and Grep/Glob/TodoWrite are
// zero — the global instruction routes those through Bash. So they get no entry
// here. Adding one later is three lines; guessing at their payload shape now
// would be three lines of fiction.

/** The wire shape `transcript_jsonl.web_sources` emits. */
export type WebSource = { url: string; title?: string; code?: number };

/** How a tool result's structure is drawn — three idioms, not three borders.
 *  The first cut (BARE, CARD) differed from INSTRUMENT by a radius and some
 *  padding, so nobody could tell them apart in the picker or the transcript.
 *  These are three different things a result can BE: a HUD readout, a
 *  terminal's own printout, a paper note — and the pick governs the WHOLE
 *  transcript (index.css, THE SESSION'S IDIOM), not just the widgets: the
 *  bubbles, the ledger, the agent block, and the reply's tables and code all
 *  answer to it. `plain` opts out of widgets, which is why it is the one style
 *  with nothing to say about the rest of the stream. */
export type ToolStyle = "instrument" | "terminal" | "note" | "plain";

export const TOOL_STYLES: { key: ToolStyle; label: string; hint: string }[] = [
  { key: "instrument", label: "INSTRUMENT", hint: "framed HUD — hard corners, hue rails" },
  { key: "terminal", label: "TERMINAL", hint: "printed — nothing wears a box" },
  { key: "note", label: "NOTE", hint: "paper — rounded, raised, roomy" },
  { key: "plain", label: "PLAIN", hint: "no widgets — the rows as they are" },
];

/** What the two redrawn styles used to be called. A stored pick keeps meaning
 *  what it meant instead of silently snapping back to the default. */
const LEGACY: Record<string, ToolStyle> = { bare: "terminal", card: "note" };

export function isToolStyle(v: unknown): v is ToolStyle {
  return TOOL_STYLES.some((s) => s.key === v);
}

/** A stored value → a style that exists. Anything unrecognised is the default. */
export function toToolStyle(v: unknown): ToolStyle {
  if (isToolStyle(v)) return v;
  return (typeof v === "string" && LEGACY[v]) || "instrument";
}

/** The structured part of a `tool_done` event — only the fields the mapping
 *  reads, so this doesn't have to track the whole union. */
type Structured = { images?: string[]; sources?: WebSource[] };

/** A widget to draw for one finished tool, or null to keep the plain row.
 *  `type` is a key `drawWidget` already understands, so adding a tool is a
 *  table entry rather than a component. */
export type ToolWidgetSpec = { label: string; type: string; value: unknown; meta?: string };

export function widgetFor(done: Structured | undefined): ToolWidgetSpec | null {
  if (!done) return null;
  if (done.sources?.length)
    return {
      label: "SOURCES", type: "sources", value: done.sources,
      meta: String(done.sources.length),
    };
  if (done.images?.length)
    return {
      label: "SCREENS", type: "screens",
      value: done.images.map((path) => ({ path })),
      meta: String(done.images.length),
    };
  return null;
}

// Where the Mini App keeps the choice. The dashboard's lives in HudSettings
// (one blob, one write); a phone has no settings blob, so this is its own key.
const STYLE_KEY = "ma-tool-style";

/** The chosen style, and a setter. Persisted per browser like every other
 *  Mini App preference (lib/persistentState). */
export function useToolStyle(): readonly [ToolStyle, (s: ToolStyle) => void] {
  const [v, set] = usePersistentState<ToolStyle>(STYLE_KEY, "instrument");
  return [toToolStyle(v), set] as const;
}
