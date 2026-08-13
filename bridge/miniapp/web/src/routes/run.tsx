import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { rootRoute } from "./root";
import { useChat } from "../lib/chat";
import { api, type PendingRequest } from "../lib/api";
import { stickToBottom } from "../lib/stick";
import { parkAt, restorePark, type Park } from "../lib/park";
import { RunStream } from "../components/RunStream";
import { Composer } from "../components/Composer";
import { Banner, Spinner } from "../components/ui";
import { AgentsPill } from "../components/AgentsPill";
import { SuggestNewSessionCard } from "../components/SuggestNewSessionCard";
import { ImageLightbox } from "../components/ImageLightbox";
import { ContextChip, GoalPill, PolicyChip } from "../components/GoalPill";
import { RunMonitor } from "../components/RunMonitor";

// Shared empty list — a fresh `[]` per render would defeat RunStream's memo.
const NO_PENDING: PendingRequest[] = [];

function RunPage() {
  const {
    turns, activeTurn, sessionWorking, respond, sendError, sessionId, isRunning, loadingSession,
    runPrompt, setDraft,
    sessions, held, heldBusy, checking, heldStartNew, heldContinue, heldDismiss,
  } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [parked, setParked] = useState(true);
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  // Where each session was last left, so switching chats — or stepping over to
  // FILES and back — returns you to what you were reading instead of the end of
  // it. No entry means it was parked at the bottom, which still follows.
  const parks = useRef(new Map<string, Park>());
  const pendingPark = useRef<Park | null>(null);
  const applyParkRef = useRef<() => void>(() => {});
  // The session whose turns are on screen. The id changes a render before the
  // transcript does (openSession empties it), and parking that empty gap would
  // wipe the very park we're about to land on.
  const shown = useRef<string | null>(null);
  shown.current = turns.length ? sessionId : null;

  // Scroll <main> itself rather than scrollIntoView-ing the end marker: that
  // parks the marker at the scrollport's bottom edge — which is *behind* the
  // fixed composer and tab bar — and stops with the reserved padding still
  // scrollable, which also reads as "scrolled up" to stickToBottom.
  const toBottom = useCallback((behavior?: ScrollBehavior) => {
    const el = bottomRef.current?.closest("main");
    el?.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // The transcript scrolls inside <main>, so that's who we watch.
  useEffect(() => {
    const el = bottomRef.current?.closest("main");
    const content = contentRef.current;
    if (!el || !content) return;
    let prev = el.scrollTop;
    // Scroll anchoring, by hand. Event cards carry `content-visibility: auto`
    // (.vskip-card), so one that has never been on screen is only the 60px
    // `contain-intrinsic-size` guess — when it renders at its real height on the
    // way past, everything below it moves and a scroll up lands somewhere the
    // gesture didn't ask for. The browser won't anchor it for us:
    // content-visibility applies `contain: layout paint`, and contained
    // elements are excluded from being anchor nodes. So whatever sits at the
    // top edge stays at the top edge. Viewport coords on purpose — where the
    // browser DID anchor, the rect hasn't moved and we correct nothing.
    let anchor: Element | null = null;
    let anchorTop = 0;
    const markAnchor = () => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 1);
      anchor = hit && el.contains(hit) ? hit : null;
      anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
      // The same anchor, kept per session: where you leave one is where you come
      // back to it.
      const sid = shown.current;
      if (!sid) return;
      const park = stick.current ? null : parkAt(el, anchor);
      if (park) parks.current.set(sid, park);
      else parks.current.delete(sid);
    };
    // Land on the park of the session we've switched to, the moment its turns
    // render (the layout effect below) — same pass the DOM changed in, so
    // nothing paints the bottom of a transcript you weren't reading.
    const applyPark = () => {
      const park = pendingPark.current;
      if (!park || !restorePark(el, park)) return;   // its turn hasn't rendered yet
      pendingPark.current = null;
      markAnchor();
      prev = el.scrollTop;
    };
    applyParkRef.current = applyPark;
    const sync = () => {
      stick.current = stickToBottom(el, prev);
      setParked(stick.current);
      prev = el.scrollTop;
      markAnchor();               // you moved: whatever is at the edge now is the anchor
    };
    el.addEventListener("scroll", sync, { passive: true });
    // Parked at the end, the effect below is already pulling us down — leave it.
    const ro = new ResizeObserver(() => {
      if (stick.current || !anchor?.isConnected) return;
      const top = anchor.getBoundingClientRect().top;
      if (top !== anchorTop) el.scrollTop += top - anchorTop;
    });
    ro.observe(content);
    markAnchor();
    applyPark();                  // coming back to this tab: the turns are already up
    return () => { el.removeEventListener("scroll", sync); ro.disconnect(); };
  }, []);

  // Switched chats: arm this session's park (or follow the latest if it was left
  // at the bottom), then land on it as soon as its transcript renders.
  useLayoutEffect(() => {
    const park = sessionId ? parks.current.get(sessionId) ?? null : null;
    pendingPark.current = park;
    stick.current = !park;
    setParked(!park);
  }, [sessionId]);
  useLayoutEffect(() => { applyParkRef.current(); }, [turns]);

  // Follow the latest message as the transcript grows, but only while parked.
  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  useEffect(() => {
    if (stick.current) toBottom();
  }, [eventCount, turns.length, toBottom]);

  return (
    <div ref={contentRef} className="space-y-3 pb-[calc(var(--composer-h,13rem)+0.75rem)]">
      {zoom && <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}

      {/* What this session is for, and what a usage limit does to it. */}
      <div className="flex items-center gap-1.5">
        <GoalPill sessionId={sessionId} />
        <PolicyChip
          sessionId={sessionId}
          stored={sessions.find((s) => s.id === sessionId)?.fallback_policy ?? null}
        />
        <ContextChip
          sessionId={sessionId}
          tokens={sessions.find((s) => s.id === sessionId)?.ctx_tokens}
          window={sessions.find((s) => s.id === sessionId)?.ctx_window}
          autocompact={sessions.find((s) => s.id === sessionId)?.autocompact}
        />
      </div>

      <RunMonitor />

      {turns.length === 0 && (
        <div className="flex items-center justify-center gap-2 pt-10 text-center text-sm text-[var(--tg-hint)]">
          {loadingSession ? (
            <>
              <Spinner className="h-3.5 w-3.5 border" /> Loading conversation…
            </>
          ) : (
            "Start a conversation with Claude."
          )}
        </div>
      )}

      {turns.map((turn, i) => {
        const isActive = turn.jobId === activeTurn?.jobId;
        const working = isActive && turn.status === "running" && activeTurn.pending.length === 0;
        return (
          // id: what a checkpoint scrolls to (CheckpointsSheet).
          <div key={turn.id} id={`turn-${turn.id}`} className="space-y-2">
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

            {/* assistant turn — everything it did hangs off one rail, so the
                turn reads as a single reply opposite your bubble instead of a
                flat column of unrelated cards. Flat, not a gradient: a turn runs
                to thousands of pixels, so anything that fades is invisible for
                most of its own length. */}
            {(turn.events.length > 0 || turn.status === "running" || turn.runtime) && (
              <div className="relative space-y-2 pl-3">
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 left-[2px] top-[11px] w-px"
                  style={{ background: "color-mix(in srgb, var(--brand-soft) 22%, transparent)" }}
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-0 top-[3px] h-[6px] w-[6px] rotate-45 border"
                  style={{ borderColor: "var(--brand-soft)", background: "var(--tg-bg)" }}
                />
                {turn.runtime && (
                  <div className="text-[11px] text-[var(--tg-hint)]">
                    {turn.runtime.startsWith("opencode:")
                      ? `⚡ free agent · ${turn.runtime.split(":")[1]}`
                      : `⇄ account ${turn.runtime.split(":")[1]}`}
                  </div>
                )}
                <RunStream
                  events={turn.events}
                  pending={isActive ? activeTurn.pending : NO_PENDING}
                  onRespond={isActive ? respond : undefined}
                  // Only the last finished turn can be replied to — a chip on an
                  // older answer would send its question back out of order.
                  // "No" is the exception: nothing to do, so it drops the
                  // session's ASK state instead of paying for a turn.
                  onAnswer={
                    i === turns.length - 1 && turn.status === "done"
                      ? (text) => void (text === "No" && sessionId
                          ? api.dismissAsk(sessionId)
                          : runPrompt(text, []))
                      : undefined
                  }
                  onWrite={setDraft}
                  ended={turn.status !== "running"}
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

      {/* Scrolled up mid-run: one tap back to the latest, and following resumes. */}
      {!parked && (
        <div
          className="pointer-events-none fixed inset-x-0 z-20 mx-auto flex max-w-screen-sm justify-end px-4"
          style={{ bottom: "calc(var(--tabbar-h) + var(--composer-h, 13rem) + 0.5rem)" }}
        >
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              setParked(true);
              toBottom("smooth");
            }}
            aria-label="Scroll to latest"
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-border bg-[var(--tg-bg)] text-[var(--tg-hint)] shadow-lg active:opacity-70"
          >
            <ChevronDown size={18} aria-hidden />
          </button>
        </div>
      )}

      <Composer />
    </div>
  );
}

export const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RunPage,
});
