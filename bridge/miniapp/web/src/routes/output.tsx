import { createRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { rootRoute } from "./root";
import { RunStream } from "../components/RunStream";
import type { RunEvent } from "../lib/api";
import { CHAT_BGS, TOOL_STYLES, useChatBg, useToolStyle, type ChatBg, type ToolStyle } from "../lib/toolwidget";

/* OUTPUT STYLE and THE GROUND — their own page, because both choices are a
   look and a list of words is not one.

   Each well is a whole TURN, drawn by the same RunStream the transcript uses
   under the real CSS, so what you tap is what the chat does. It has to be a
   turn and not a widget or two: the loudest differences between the five
   languages — where your bubble sits, what an action row's tag is shaped like,
   whether there is a T+ gutter at all — are in the parts a widget-only preview
   left out, and a ground can only be judged with words on it.

   The previews are `inert`: a picture, not a document — their rows and links
   take neither a tap nor a tab stop from the row that owns them. */
const PREVIEW_TURN: RunEvent[] = [
  // One of each tier, because tier is what the ledger draws differently: a
  // `mark` that changed a file, then a `reach` that left the phone and came
  // back with structure, then the reply.
  { type: "tool", name: "Edit", summary: "lib/toolwidget.ts", id: "s1" },
  { type: "tool_done", id: "s1", ms: 240, stat: "1 edit" },
  { type: "tool", name: "WebSearch", summary: "css subgrid support", id: "s2" },
  {
    type: "tool_done", id: "s2", ms: 1830,
    sources: [
      { url: "https://docs.claude.com/en/docs/claude-code", title: "Claude Code — overview", code: 200 },
      { url: "https://developer.mozilla.org/en-US/docs/Web/CSS", title: "CSS reference — MDN", code: 200 },
    ],
  },
  {
    type: "text",
    text: "`Idiom` gained a fifth member and the table still lists four:\n\n| Tool | Share |\n| --- | --- |\n| Bash | 70% |\n| Read | 10% |",
  },
];

function Well({ style, bg, prompt }: { style: ToolStyle; bg: ChatBg; prompt: string }) {
  return (
    <div inert data-style={style} data-bg={bg} className="space-y-2 border-t border-border bg-[var(--tg-bg)] px-3 py-3">
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          <div className="pbub whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--tg-button)] px-3 py-2 text-sm text-[var(--tg-button-text)]">
            {prompt}
          </div>
        </div>
      </div>
      <RunStream events={PREVIEW_TURN} />
    </div>
  );
}

function Tile({ label, hint, on, onPick, children }: {
  label: string;
  hint: string;
  on: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onPick}
      aria-pressed={on}
      className={`block w-full overflow-hidden border text-left active:opacity-70 ${
        on ? "border-[var(--brand-soft)] bg-[var(--ac-06)]" : "border-border bg-[var(--tg-secondary-bg)]"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="shrink-0 text-[11px] tracking-[1.5px]">{label}</span>
        {on && <span className="shrink-0 text-[var(--brand-soft)]" aria-hidden>&#10003;</span>}
        {/* Wraps rather than truncating: the hint is the sentence that tells
            the two quiet ones apart, and an ellipsis ate it. */}
        <span className="ml-auto min-w-0 text-right text-[10px] leading-snug text-[var(--tg-hint)]">{hint}</span>
      </div>
      {children}
    </button>
  );
}

function OutputPage() {
  const [style, setStyle] = useToolStyle();
  const [bg, setBg] = useChatBg();
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
        {TOOL_STYLES.map((o) => (
          <Tile key={o.key} label={o.label} hint={o.hint} on={style === o.key} onPick={() => setStyle(o.key)}>
            <Well style={o.key} bg={bg} prompt="the fifth idiom isn't in the table" />
          </Tile>
        ))}
      </div>

      <div className="pt-2 text-[13px] tracking-[3px] text-foreground-bright">THE GROUND</div>
      <p className="text-[11px] leading-relaxed text-[var(--tg-hint)]">
        The texture the chat is read on — independent of the language above it. All four
        are hairlines at the ghost ink tier: a ground you keep re-focusing on is one
        you'd turn off by the second screen.
      </p>

      <div className="space-y-2.5">
        {CHAT_BGS.map((o) => (
          <Tile key={o.key} label={o.label} hint={o.hint} on={bg === o.key} onPick={() => setBg(o.key)}>
            <Well style={style} bg={o.key} prompt="does this still read?" />
          </Tile>
        ))}
      </div>
    </div>
  );
}

export const outputRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/output",
  component: OutputPage,
});
