import { createRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { rootRoute } from "./root";
import { ToolWidget } from "../components/ResultWidgets";
import { toolAccent } from "../lib/tools";
import { TOOL_STYLES, useToolStyle, type ToolWidgetSpec } from "../lib/toolwidget";

/* OUTPUT STYLE — its own page, because the choice is a look and a list of four
   words is not one. Each row draws the REAL ToolWidget under the real CSS, so
   what you tap is what the transcript does; PLAIN draws the one-line row you
   get instead, since "no widget" only means something next to it.

   The previews are `inert`: a picture, not a document — their links take
   neither a tap nor a tab stop from the row that owns them. */

const PREVIEW: ToolWidgetSpec = {
  label: "SOURCES",
  type: "sources",
  meta: "3",
  value: [
    { url: "https://docs.claude.com/en/docs/claude-code", title: "Claude Code — overview", code: 200 },
    { url: "https://github.com/anthropics/claude-code", title: "anthropics/claude-code", code: 200 },
    { url: "https://developer.mozilla.org/en-US/docs/Web/CSS", title: "CSS reference — MDN", code: 200 },
  ],
};

function OutputPage() {
  const [style, setStyle] = useToolStyle();
  const hue = toolAccent("WebSearch");
  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-baseline gap-2.5">
        <Link
          to="/system"
          className="flex items-center gap-0.5 text-[10px] tracking-wider text-[var(--tg-hint)] active:opacity-70"
        >
          <ChevronLeft size={13} aria-hidden />
          SYSTEM
        </Link>
        <span className="text-[13px] tracking-[3px] text-foreground-bright">OUTPUT STYLE</span>
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--tg-hint)]">
        How a tool result&apos;s own structure is drawn — the pages a search reached, the
        screenshots a run handed back. A tool with nothing structured to show keeps its
        one-line row whatever this says.
      </p>

      <div className="space-y-2.5">
        {TOOL_STYLES.map((o) => {
          const on = style === o.key;
          return (
            <button
              key={o.key}
              onClick={() => setStyle(o.key)}
              aria-pressed={on}
              className={`block w-full overflow-hidden border text-left active:opacity-70 ${
                on ? "border-[var(--brand-soft)] bg-[var(--ac-06)]" : "border-border bg-[var(--tg-secondary-bg)]"
              }`}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="shrink-0 text-[11px] tracking-[1.5px]">{o.label}</span>
                {on && <span className="shrink-0 text-[var(--brand-soft)]" aria-hidden>&#10003;</span>}
                <span className="ml-auto min-w-0 truncate text-[10px] text-[var(--tg-hint)]">{o.hint}</span>
              </div>
              <div inert className="border-t border-border bg-[var(--tg-bg)] px-3 py-3">
                {o.key === "plain" ? <PlainRow /> : <ToolWidget spec={PREVIEW} accent={hue} style={o.key} />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What PLAIN leaves you: the row the tool always had. The phone's transcript
 *  draws that row inside RunStream's own event switch, so this is a still of
 *  it rather than a second renderer to keep in sync. */
function PlainRow() {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-[var(--brand-soft)]">▸</span>
      <span className="tracking-[1.2px] text-[var(--brand-soft)]">WEBSEARCH</span>
      <span className="min-w-0 truncate text-[var(--tg-hint)]">claude code bridge</span>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--muted-2)]">3 sources</span>
    </div>
  );
}

export const outputRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/output",
  component: OutputPage,
});
