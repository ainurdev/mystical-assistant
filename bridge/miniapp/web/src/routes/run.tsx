import { useEffect, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { useChat } from "../lib/chat";
import type { PendingRequest } from "../lib/api";
import { RunStream } from "../components/RunStream";
import { Composer } from "../components/Composer";
import { RunningNow } from "../components/RunningNow";
import { Banner } from "../components/ui";
import { AgentsPill } from "../components/AgentsPill";
import { SuggestNewSessionCard } from "../components/SuggestNewSessionCard";
import { ImageLightbox } from "../components/ImageLightbox";

// Shared empty list — a fresh `[]` per render would defeat RunStream's memo.
const NO_PENDING: PendingRequest[] = [];

function RunPage() {
  const {
    turns, activeTurn, sessionWorking, respond, reviewResolve, sendError, sessionId, isRunning,
    sessions, held, heldBusy, checking, heldStartNew, heldContinue, heldDismiss,
  } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  // Auto-scroll to the latest message as the transcript grows.
  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [eventCount, turns.length]);

  return (
    <div className="space-y-4 pb-44">
      {zoom && <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
      <RunningNow />

      {turns.length === 0 && (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">
          Start a conversation with Claude.
        </div>
      )}

      {turns.map((turn) => {
        const isActive = turn.jobId === activeTurn?.jobId;
        const working = isActive && turn.status === "running" && activeTurn.pending.length === 0;
        return (
          <div key={turn.id} className="space-y-2">
            {/* user message */}
            <div className="flex justify-end">
              <div className="max-w-[85%] space-y-1">
                {turn.attachments.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {turn.attachments.filter((a) => a.dataUrl).map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setZoom({ src: a.dataUrl as string, alt: a.name })}
                        aria-label={`Open ${a.name}`}
                        className="block"
                      >
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          className="h-16 w-16 rounded-lg object-cover"
                        />
                      </button>
                    ))}
                    {/* Rehydrated history has no blob to render — show a count. */}
                    {turn.attachments.filter((a) => !a.dataUrl).length > 0 && (
                      <span className="text-xs text-[var(--tg-hint)]">
                        📎 {turn.attachments.filter((a) => !a.dataUrl).length} image
                        {turn.attachments.filter((a) => !a.dataUrl).length > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                )}
                {turn.prompt && (
                  <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--tg-button)] px-3 py-2 text-sm text-[var(--tg-button-text)]">
                    {turn.prompt}
                  </div>
                )}
              </div>
            </div>

            {/* assistant turn */}
            {(turn.events.length > 0 || turn.status === "running") && (
              <div className="space-y-2">
                <RunStream
                  events={turn.events}
                  pending={isActive ? activeTurn.pending : NO_PENDING}
                  onRespond={isActive ? respond : undefined}
                  onReviewResolve={reviewResolve}
                />
                {working && <div className="text-xs text-[var(--tg-hint)]">Working…</div>}
              </div>
            )}
          </div>
        );
      })}

      {/* Native (VS Code) live session: no bridge turn is "running", so the
          working state comes from the unified status map. */}
      {sessionWorking && !activeTurn && (
        <div className="text-xs text-[var(--tg-hint)]">Working…</div>
      )}

      {sendError && (
        <Banner tone="error">
          {sendError.busy
            ? "Claude is busy with another task."
            : sendError.unauthorized
              ? "Unauthorized"
              : "Failed to send."}
        </Banner>
      )}

      {checking && !isRunning && (
        <div className="text-xs text-[var(--tg-hint)]">Checking this fits the session…</div>
      )}

      {held && (
        <SuggestNewSessionCard
          currentTitle={sessions.find((s) => s.id === sessionId)?.title ?? ""}
          reason={held.reason}
          suggestedTitle={held.title}
          busy={heldBusy}
          onStartNew={() => void heldStartNew()}
          onContinue={() => void heldContinue()}
          onDismiss={heldDismiss}
        />
      )}

      <AgentsPill sessionId={sessionId} running={isRunning} />
      <div ref={bottomRef} />
      <Composer />
    </div>
  );
}

export const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RunPage,
});
