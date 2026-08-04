import { useState, type RefObject } from "react";
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

/** Which runtime ran this turn — shown only when it wasn't the default Claude
 *  account, so fallback-ladder work (another login, a free agent) stays visible. */
function RuntimeBadge({ runtime }: { runtime: string }) {
  const [kind, arg] = runtime.split(":", 2);
  const free = kind === "opencode";
  const label = free ? `FREE AGENT · ${(arg || "?").toUpperCase()}` : `ACCOUNT ${arg}`;
  return (
    <div className="ml-[27px] flex">
      <span
        className="border px-1.5 py-px text-[9.5px] tracking-[1px]"
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
  lastPromptRef,
  hud,
  onRunCommand,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
  lastPromptRef?: RefObject<HTMLDivElement | null>;
  hud?: HudSettings;
  onRunCommand?: (command: string) => void;
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
            {turn.runtime && <RuntimeBadge runtime={turn.runtime} />}
            {turn.attachments && turn.attachments.length > 0 && (
              <Attachments items={turn.attachments} />
            )}
            {(turn.events.length > 0 || turn.status === "running") && (
              <RunStream
                events={turn.events}
                pending={turn.pending as PendingRequest[]}
                onRespond={isActive ? onRespond : undefined}
                animate={liveTurns?.has(turn.id) ?? false}
                turnId={turn.id}
                openResults={hud?.openResults ?? false}
                onRunCommand={onRunCommand}
                ended={turn.status !== "running"}
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
