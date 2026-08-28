import { createRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { rootRoute } from "./root";
import { ToolWidget } from "../components/ResultWidgets";
import { toolAccent } from "../lib/tools";
import { TOOL_STYLES, useToolStyle, type ToolWidgetSpec } from "../lib/toolwidget";

/* OUTPUT STYLE — its own page, because the choice is a look and a list of five
   words is not one. Each row draws the REAL widgets and the REAL markdown under
   the real CSS, so what you tap is what the transcript does.

   The previews are `inert`: a picture, not a document — their links take
   neither a tap nor a tab stop from the row that owns them. */

/* Two payloads, not one: SOURCES draws in the zero-chrome STRIP idiom, so a
   tile showing only that would preview the language's type and none of its
   chrome. OUTPUT is a PLATE, which is where a material has a frame to show. */
const PREVIEW_PLATE: ToolWidgetSpec = {
  label: "OUTPUT",
  type: "output",
  meta: "2 lines",
  value: { cmd: "tsc -p tsconfig.app.json", ok: false, text: "lib/toolwidget.ts:41:12\nerror TS2322: not assignable to 'Idiom'" },
};

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
        How the whole session draws — your messages, the reply, its tables and its code,
        and the structure a tool handed back. Five languages; each one is a whole
        grammar, not a border swap.
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
              {/* data-style, not just the widget's own data-tw: the pick
                  governs the whole stream, so the well is a slice of one. */}
              <div inert data-style={o.key} className="border-t border-border bg-[var(--tg-bg)] px-3 py-3">
                <ToolWidget spec={PREVIEW_PLATE} accent={hue} style={o.key} />
                <ToolWidget spec={PREVIEW} accent={hue} style={o.key} />
                <div className="md mt-2 text-[11px]">
                  <div className="md-tablewrap">
                    <table>
                      <thead><tr><th>Tool</th><th>Share</th></tr></thead>
                      <tbody>
                        <tr><td>Bash</td><td>70%</td></tr>
                        <tr><td>Read</td><td>10%</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const outputRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/output",
  component: OutputPage,
});
