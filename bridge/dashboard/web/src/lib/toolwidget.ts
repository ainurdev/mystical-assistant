
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

/** How a tool result's structure is drawn, and how the whole session reads.
 *  Five languages, one per column of the Chat Elements sheet. Each is a whole
 *  grammar rather than a border swap: they differ in what carries rank (a fill,
 *  a stroke, a chip's saturation, a rule's weight, how far a surface floats),
 *  in whether anything is a box at all, and in reading rhythm. If two of them
 *  are ever telling apart by their corner radius, the redraw has failed.
 *
 *  The pick governs the WHOLE transcript (index.css, THE SESSION'S IDIOM), not
 *  just the widgets: the bubbles, the action ledger, the run window, the agent
 *  block, and the reply's tables and code all answer to it.
 *
 *  `stamp` leads and is the default because it is the one the HUD already
 *  authors — the rest of index.css IS a control plate, so the other four are
 *  overrides off it. It is keyed `stamp` rather than `plate` because `plate` is
 *  already an Idiom below, and a material must never be readable as a weight. */
export type ToolStyle = "stamp" | "wire" | "signal" | "press" | "halo";

export const TOOL_STYLES: { key: ToolStyle; label: string; hint: string }[] = [
  { key: "stamp", label: "CONTROL PLATE", hint: "stamped plates — no radius, one hue for consequence, rank is fill weight" },
  { key: "wire", label: "WIRE", hint: "a schematic — nothing is a card, every element is a node on one spine" },
  { key: "signal", label: "SIGNAL LOG", hint: "a log viewer — elapsed time in the gutter, a level chip, one row per event" },
  { key: "press", label: "LEDGER PRESS", hint: "print — not one box, rank is a rule's weight and whether a label is ink or italic" },
  { key: "halo", label: "HALO", hint: "surfaces, not rules — one radius, quiet by default, loud only when something changed" },
];

/** What the styles were called before the sheet replaced them. A stored pick
 *  lands on its nearest new language instead of silently snapping to default.
 *  PLAIN was the widget opt-out and has no column, so it maps to the quietest
 *  one there is. */
const LEGACY: Record<string, ToolStyle> = {
  instrument: "stamp", terminal: "wire", note: "press", plain: "wire",
  bare: "wire", card: "press",
};

export function isToolStyle(v: unknown): v is ToolStyle {
  return TOOL_STYLES.some((s) => s.key === v);
}

/** A stored value → a style that exists. Anything unrecognised is the default. */
export function toToolStyle(v: unknown): ToolStyle {
  if (isToolStyle(v)) return v;
  return (typeof v === "string" && LEGACY[v]) || "stamp";
}

/** How much chrome a result wears, and at what x it hangs off the turn.
 *
 *  The old answer was "one frame for every widget — what changes between them
 *  is the body, never the chrome", which made a four-shot gallery and a
 *  two-link source list the same object at a glance. The new answer is that
 *  chrome is a function of the payload's SHAPE, not the tool's name:
 *
 *    trace   one scalar          no chrome at all; rides the row's stat cell
 *    strip   a flat list         a band at the text column, hairline, no box
 *    ledger  rows with a state   the action grid again, flush left
 *    plate   a blob to read      a framed well inset to its own gutter
 *    field   spatial / visual    a stage: breaks the column, bleeds right
 *
 *  The attachment x is the point: quiet results hug the turn's rail and loud
 *  ones break out of it, so a turn's ragged left edge reads as a graph of how
 *  much each step produced — before you read a word of it. */
export type Idiom = "trace" | "strip" | "ledger" | "plate" | "field";

/** Which idiom each widget type draws in. Keyed by the `type` drawWidget already
 *  understands, so adding a widget is still a table entry rather than a
 *  component — the idiom just decides its frame instead of every widget sharing
 *  one. Anything missing falls back to `strip`, which is the idiom that assumes
 *  the least about a payload it has never seen. */
const IDIOM: Record<string, Idiom> = {
  verdict: "trace", confidence: "trace",
  files: "strip", sources: "strip", stats: "strip", claims: "strip", meters: "strip",
  checks: "ledger", commands: "ledger", plan: "ledger", findings: "ledger",
  chain: "ledger", intake: "ledger",
  output: "plate", draft: "plate", diff: "plate", table: "plate",
  screens: "field", map: "field", chart: "field", ideas: "field",
};

export function idiomFor(type: string): Idiom {
  return IDIOM[type] ?? "strip";
}

/** Every widget type that has a drawing, in ladder order. The settings preview
 *  and the check file both want this list; neither should hand-maintain it. */
export const WIDGET_TYPES = Object.keys(IDIOM);

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

/** One widget for a whole run of results. A group is drawn by its head, so a
 *  member's shots or sources would never reach the screen otherwise — and five
 *  Reads of five PNGs are one contact sheet, not five galleries a screen tall.
 *  Payloads concatenate; precedence stays widgetFor's. */
export function widgetForRun(dones: (Structured | undefined)[]): ToolWidgetSpec | null {
  return widgetFor({
    sources: dones.flatMap((d) => d?.sources ?? []),
    images: dones.flatMap((d) => d?.images ?? []),
  });
}
