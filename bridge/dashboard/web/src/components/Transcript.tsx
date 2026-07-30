import { useState, type RefObject } from "react";
import { api, type AnswerSelection } from "../api";
import type { PendingRequest, Turn } from "../chat";
import type { HudSettings } from "../lib/theme";
import { RunStream } from "./RunStream";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";
import { ckId } from "./hud/Checkpoints";
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
    <div className="flex gap-[9px]">
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
      <span className="flex-none select-none text-violet opacity-0" aria-hidden>
        ~ ❯
      </span>
      <div className="flex flex-wrap items-center gap-2">
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
          <span className="text-[11px] tracking-[0.5px] text-muted-2">
            📎 {missing} image{missing > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
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
  onReviewResolve,
  liveTurns,
  trailingWorking,
  lastPromptRef,
  hud,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
  onReviewResolve?: (itemId: string, action: "keep" | "skip") => void;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
  lastPromptRef?: RefObject<HTMLDivElement | null>;
  hud?: HudSettings;
}) {
  if (!turns.length) {
    return <RuneSpirit variant="block" />;
  }
  return (
    // ponytail: every turn stays mounted — memoized RunStreams make re-renders
    // free, but the DOM still holds the whole session. Virtualize with
    // @tanstack/react-virtual (already a dep) if scrolling ever gets heavy.
    <div className="flex flex-col gap-3">
      {turns.map((turn, i) => {
        const isActive = turn.id === activeId;
        const isLast = i === turns.length - 1;
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        return (
          <div key={turn.id} id={ckId(turn.id)} className="flex flex-col gap-1.5 scroll-mt-2">
            {turn.prompt && (
              <div ref={isLast ? lastPromptRef : undefined} className="flex gap-[9px]">
                <span className="flex-none text-violet">~ ❯</span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-foreground-bright">
                  {turn.prompt}
                </span>
              </div>
            )}
            {turn.attachments && turn.attachments.length > 0 && (
              <Attachments items={turn.attachments} />
            )}
            {(turn.events.length > 0 || turn.status === "running") && (
              <RunStream
                events={turn.events}
                pending={turn.pending as PendingRequest[]}
                onRespond={isActive ? onRespond : undefined}
                onReviewResolve={onReviewResolve}
                animate={liveTurns?.has(turn.id) ?? false}
                turnId={turn.id}
              />
            )}
            {working && <WorkingIndicator hud={hud} />}
          </div>
        );
      })}
      {/* Native (VS Code) live session: no turn is ever "running", so the working
          state comes from the unified status map instead of turn.status. */}
      {trailingWorking && <WorkingIndicator hud={hud} />}
    </div>
  );
}
