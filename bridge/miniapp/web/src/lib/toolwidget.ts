// Mirrors bridge/dashboard/web/src/lib/toolwidget.ts. Keep them in sync; the
// phone has no HudSettings object, so its one browser-side pick (the ground)
// is read here through usePersistentState.
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

/** How the whole session reads on the phone. One language since the settings
 *  remap (2026-10-15): CONTROL PLATE, the one the rest of index.css authors. */
export type ToolStyle = "stamp";

/** The texture the transcript is read ON. A language decides how a turn is
 *  drawn; this decides what it is drawn on — and the two are independent, so
 *  they are two settings rather than one.
 *
 *  Four grounds and OFF, all authored the same way: one hairline family at the
 *  ghost ink tier, tiled at a reading pitch. None of them is a picture. The
 *  constraint is the only interesting thing here — a transcript is read for
 *  minutes at a time, so a ground that competes for a single fixation has
 *  already failed, however good it looks in a settings tile. */
export type ChatBg = "none" | "grid" | "dots" | "rule" | "tooth";

export const CHAT_BGS: { key: ChatBg; label: string; hint: string }[] = [
  { key: "none", label: "NONE", hint: "the theme's own ground, unmarked" },
  { key: "grid", label: "GRAPH", hint: "square hairline grid — the drafting sheet under the work" },
  { key: "dots", label: "MATRIX", hint: "a dot at every crossing, no lines — the quietest of the four" },
  { key: "rule", label: "RULED", hint: "horizontal rules only, at the reading pitch — nothing crosses a word" },
  { key: "tooth", label: "TOOTH", hint: "a fine diagonal weave — paper grain rather than a grid" },
];

export function toChatBg(v: unknown): ChatBg {
  return CHAT_BGS.some((b) => b.key === v) ? (v as ChatBg) : "none";
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

/** What a shot is called under it. Every image a tool returns is saved as
 *  mcp-<tool_use_id>-<n>.png (bridge/runner._save_result_images), so the file
 *  can't name it and the gallery numbered them — SHOT 1, SHOT 2 — which says
 *  nothing four screenshots into a session. The call that produced it can: a
 *  url gives its page, a path its file, anything else itself. */
export function shotName(summary: string): string {
  const s = (summary || "").trim().split(/[?#]/)[0].replace(/\/+$/, "");
  return (s.split("/").pop() || s).slice(0, 40);
}

const BG_KEY = "ma-chat-bg";

/** The ground the transcript is read on, and a setter. Same storage story. */
export function useChatBg(): readonly [ChatBg, (b: ChatBg) => void] {
  const [v, set] = usePersistentState<ChatBg>(BG_KEY, "none");
  return [toChatBg(v), set] as const;
}

/** One widget for a whole run of results — one call or twenty. A group is drawn
 *  by its head, so a member's shots or sources would never reach the screen
 *  otherwise, and five Reads of five PNGs are one contact sheet rather than
 *  five galleries a screen tall. Payloads concatenate; sources win over shots.
 *  Fed the whole call and not just its result, because what a shot should be
 *  called is in the input. */
export function widgetForRun(calls: { done?: Structured; summary?: string }[]): ToolWidgetSpec | null {
  const sources = calls.flatMap((c) => c.done?.sources ?? []);
  if (sources.length)
    return { label: "SOURCES", type: "sources", value: sources, meta: String(sources.length) };
  const shots = calls.flatMap((c) => {
    const paths = c.done?.images ?? [];
    const name = shotName(c.summary ?? "");
    // One call, several frames: the name alone would caption them identically.
    return paths.map((path, i) => ({
      path, caption: name && paths.length > 1 ? `${name} · ${i + 1}` : name || undefined,
    }));
  });
  if (shots.length)
    return { label: "SCREENS", type: "screens", value: shots, meta: String(shots.length) };
  return null;
}
