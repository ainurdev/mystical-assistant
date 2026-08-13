import { useState } from "react";
import { api, type AnswerSelection } from "../api";
import type { PendingRequest, Turn } from "../chat";
import type { HudSettings } from "../lib/theme";
import { RunStream } from "./RunStream";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";
import { ckId } from "../lib/checkpoints";
import { WorkingIndicator } from "./hud/WorkingIndicator";
import { RuneSpirit } from "./hud/RuneSpirit";

function Attachments({ items }: { items: string[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  // A just-sent turn carries data: URLs; a rehydrated one carries server paths the
  // dashboard serves back from the upload dir. Those files are cleaned up when the
  // run ends, so an image that 404s collapses into the chip it used to be.
  const srcs = items.map((a) =>
    a.startsWith("data:") || a.startsWith("http") ? a : api.attachmentUrl(a));
  const missing = srcs.filter((s) => gone.has(s)).length;
  return (
    // Yours, so they hang off the right edge under your bubble.
    <div className="flex justify-end">
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
      <div className="flex max-w-[78%] flex-wrap items-center justify-end gap-2">
        {srcs.map((src, i) =>
          gone.has(src) ? null : (
            <ZoomButton key={i} onOpen={() => setZoom(src)}>
              <img
                src={src}
                alt="attachment"
                onError={() => setGone((g) => new Set(g).add(src))}
                className="h-16 w-16 border border-border object-cover"
              />
            </ZoomButton>
          ),
        )}
        {missing > 0 && (
          <span className="text-[length:var(--t11)] tracking-[0.5px] text-muted-2">
            📎 {missing} image{missing > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}

/** Which runtime ran this turn — shown only when it wasn't the default Claude
 *  account, so fallback-ladder work (another login, a free agent) stays visible. */
function RuntimeBadge({ runtime }: { runtime: string }) {
  const [kind, arg] = runtime.split(":", 2);
  const free = kind === "opencode";
  const label = free ? `FREE AGENT · ${(arg || "?").toUpperCase()}` : `ACCOUNT ${arg}`;
  return (
    <div className="ml-[18px] flex">
      <span
        className="border px-1.5 py-px text-[length:var(--t95)] tracking-[1px]"
        style={{
          color: free ? "var(--warn)" : "var(--acc)",
          borderColor: "color-mix(in srgb, currentColor 40%, transparent)",
        }}
        title={free
          ? "Ran on a free agent (opencode) after a usage limit — weaker model, review its work"
          : "Ran on another Claude account after a usage limit"}
      >
        {free ? "⚡ " : "⇄ "}{label}
      </span>
    </div>
  );
}

/** What you said, drawn as the one thing in the transcript that comes from your
 *  side: right-aligned, violet, with the solid bar on the right edge — the mirror
 *  of the bar a WRITE card wears on its left. No speaker label: the side is the
 *  label, the way it is in every chat. */
function PromptBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[78%] border border-r-[3px] px-3 py-1.5"
        style={{
          borderColor: "color-mix(in srgb, var(--purple) 26%, transparent)",
          borderRightColor: "var(--purple)",
          background: "color-mix(in srgb, var(--purple) 7%, transparent)",
        }}
      >
        <span className="block whitespace-pre-wrap break-words leading-relaxed text-foreground-bright">
          {text}
        </span>
      </div>
    </div>
  );
}

/** The agent's side of the chat: a hairline down the 18px gutter every card in a
 *  turn already indents past, capped by a diamond where the turn starts. One line
 *  instead of a bubble per card — the cards are the message. */
function AgentRail() {
  return (
    <>
      {/* Flat, not a gradient: a turn runs to thousands of pixels, so anything
          that fades out is invisible for most of its own length. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-1 left-[6px] top-[14px] w-px"
        style={{ background: "var(--ac-12)" }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-[3px] top-[6px] h-[7px] w-[7px] rotate-45 border"
        style={{ borderColor: "var(--acc)", background: "var(--panel3)" }}
      />
    </>
  );
}

type Respond = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

export function Transcript({
  turns,
  activeId,
  onRespond,
  liveTurns,
  trailingWorking,
  hud,
  onRunCommand,
  onQuote,
  onOpenFile,
  onAnswer,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
  hud?: HudSettings;
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onAnswer?: (text: string) => void;
}) {
  if (!turns.length) {
    return <RuneSpirit variant="block" />;
  }
  return (
    // ponytail: every turn stays mounted — memoized RunStreams make re-renders
    // free, and each RunStream's cards skip layout/paint off-screen (.vskip-card),
    // so the mounted DOM costs almost nothing. Not virtualized on purpose: that
    // would cost us ctrl-F, checkpoint anchors and scroll-to-bottom to rebuild.
    // The turn wrapper itself must stay uncontained — Attachments renders the
    // position:fixed ImageLightbox inside it.
    <div className="flex flex-col gap-3">
      {turns.map((turn, i) => {
        const isActive = turn.id === activeId;
        const isLast = i === turns.length - 1;
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        const replied = turn.events.length > 0 || turn.status === "running" || !!turn.runtime;
        return (
          <div key={turn.id} id={ckId(turn.id)} className="flex flex-col gap-2 scroll-mt-[44px]">
            {turn.prompt && (
              <div data-prompt-idx={i}>
                <PromptBubble text={turn.prompt} />
              </div>
            )}
            {turn.attachments && turn.attachments.length > 0 && (
              <Attachments items={turn.attachments} />
            )}
            {/* Everything the agent did, hung off one rail. position:relative is
                safe here — the ImageLightbox inside is fixed, and only transform
                or filter on an ancestor would reparent that. */}
            {replied && (
              <div className="relative space-y-1.5">
                <AgentRail />
                {turn.runtime && <RuntimeBadge runtime={turn.runtime} />}
                {(turn.events.length > 0 || turn.status === "running") && (
                  <RunStream
                    events={turn.events}
                    pending={turn.pending as PendingRequest[]}
                    onRespond={isActive ? onRespond : undefined}
                    animate={liveTurns?.has(turn.id) ?? false}
                    turnId={turn.id}
                    tokens={turn.tokens ?? null}
                    openResults={hud?.openResults ?? false}
                    onRunCommand={onRunCommand}
                    onQuote={onQuote}
                    onOpenFile={onOpenFile}
                    // Only the last finished turn can be replied to — a chip on an
                    // older answer would send its question back out of order.
                    onAnswer={isLast && turn.status === "done" ? onAnswer : undefined}
                    ended={turn.status !== "running"}
                  />
                )}
                {working && <WorkingIndicator hud={hud} />}
              </div>
            )}
          </div>
        );
      })}
      {/* Native (VS Code) live session: no turn is ever "running", so the working
          state comes from the unified status map instead of turn.status. */}
      {trailingWorking && <WorkingIndicator hud={hud} />}
    </div>
  );
}
