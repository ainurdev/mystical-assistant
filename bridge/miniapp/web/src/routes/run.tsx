import { useCallback, useEffect, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { rootRoute } from "./root";
import { useChat } from "../lib/chat";
import { api, type PendingRequest } from "../lib/api";
import { stickToBottom } from "../lib/stick";
import { anchorAt, recall, remember, type Anchor } from "../lib/scrollmem";
import { RunStream, TURN_TAIL } from "../components/RunStream";
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
    hasOlder, olderLoading, loadOlder, renderFrom, transcriptNav,
  } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [parked, setParked] = useState(true);
  // Where the open session was left, held until its turns are on screen — and
  // then a beat longer, because the rows keep measuring after they land and
  // every measurement moves the pixel the anchor points at.
  const restoreTo = useRef<Anchor | null>(null);
  const restoreT = useRef(0);
  const endRestore = useCallback(() => {
    restoreTo.current = null;
    window.clearTimeout(restoreT.current);
    restoreT.current = 0;
  }, []);
  // Reassigned every render: the scroll listener mounts once, but has to save
  // against the session and the rows that are on screen *now*.
  const keepPlace = useRef<() => void>(() => {});
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  // The scroller is <main> from the root layout — captured once mounted so the
  // virtualizer (which reads it lazily) sees a real element, not null.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setScrollEl(bottomRef.current?.closest("main") ?? null); }, []);

  // Scroll <main> itself rather than scrollIntoView-ing the end marker: that
  // parks the marker at the scrollport's bottom edge — which is *behind* the
  // fixed composer and tab bar — and stops with the reserved padding still
  // scrollable, which also reads as "scrolled up" to stickToBottom.
  const toBottom = useCallback((behavior?: ScrollBehavior) => {
    const el = bottomRef.current?.closest("main");
    el?.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Opening a session goes back to where you were reading it; one you've never
  // opened (or left parked on the latest) starts at the bottom, as before.
  // Runs on mount too, which is what makes the CHATS/WORK round trip keep the
  // place as well — this page unmounts with the tab.
  useEffect(() => {
    const was = sessionId ? recall(sessionId) : undefined;
    endRestore();
    restoreTo.current = was && was !== "bottom" ? was : null;
    stick.current = !restoreTo.current;
    setParked(stick.current);
  }, [sessionId, endRestore]);

  // The transcript scrolls inside <main>, so that's who we watch. Anchoring
  // against content shifting above the viewport now lives in the virtualizer
  // (shouldAdjustScrollPositionOnItemSizeChange below) — what remains here is
  // the follow policy: when to stick to the bottom.
  useEffect(() => {
    const el = bottomRef.current?.closest("main");
    if (!el) return;
    let prev = el.scrollTop;
    const sync = () => {
      // Mid-restore the scrolling is ours, and the half-settled positions on
      // the way must not be read as you parking somewhere.
      if (restoreTo.current) { prev = el.scrollTop; return; }
      stick.current = stickToBottom(el, prev);
      setParked(stick.current);
      prev = el.scrollTop;
      keepPlace.current();
    };
    el.addEventListener("scroll", sync, { passive: true });
    // Touch the transcript mid-restore and it's yours again.
    el.addEventListener("touchstart", endRestore, { passive: true });
    el.addEventListener("wheel", endRestore, { passive: true });
    return () => {
      el.removeEventListener("scroll", sync);
      el.removeEventListener("touchstart", endRestore);
      el.removeEventListener("wheel", endRestore);
    };
  }, [endRestore]);

  // Follow the latest message as the transcript grows, but only while parked.
  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  useEffect(() => {
    if (stick.current) toBottom();
  }, [eventCount, turns.length, toBottom]);

  // Tail loading: turns always ship whole but only the last few carry events.
  // Turns before the cut hide behind the LOAD OLDER control (they'd render as
  // bare bubbles with missing bodies otherwise).
  const cutIdx = renderFrom ? turns.findIndex((t) => t.id === renderFrom) : 0;
  const visibleTurns = cutIdx > 0 ? turns.slice(cutIdx) : turns;

  // Measured heights survive unmount so a revisited turn is estimated exactly
  // right — same "wrong only once" property the cards' content-visibility has.
  const sizesRef = useRef(new Map<string, number>());
  // The list sits below the chips/monitor block inside <main>; the virtualizer
  // needs that offset so row coordinates line up with real scroll positions.
  const [listOffset, setListOffset] = useState(0);
  useEffect(() => {
    const list = listRef.current;
    if (!scrollEl || !list) return;
    setListOffset(list.getBoundingClientRect().top
      - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop);
  }, [scrollEl, hasOlder, turns.length > 0]);

  const virtualizer = useVirtualizer({
    count: visibleTurns.length,
    getScrollElement: () => scrollEl,
    getItemKey: (i) => visibleTurns[i].id,
    // ~20px/event: chip folding compresses far below one card per event; the
    // cache replaces the guess with truth after first mount.
    // Capped the same way the row renders — a 400-event turn mounts its last
    // TURN_TAIL, so estimating off the full length would guess ~7x too tall.
    estimateSize: (i) => sizesRef.current.get(visibleTurns[i].id)
      ?? Math.min(20000, 80 + Math.min(visibleTurns[i].events.length, TURN_TAIL) * 20),
    overscan: 2,
    scrollMargin: listOffset,
    measureElement: (el) => {
      const h = el.getBoundingClientRect().height;
      const k = el.getAttribute("data-key");
      if (k) sizesRef.current.set(k, h);
      return h;
    },
  });
  // A row above the viewport re-measuring must not slide what you're reading —
  // the replacement for the hand-rolled anchor correction this file used to do.
  // Except while we're scrolling back to a remembered place: the row you land
  // *inside* measures right after, and this correction reads that growth as
  // "content above you got taller" and pushes you the whole height of the turn.
  // During a restore the anchor owns the scroll position.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    !restoreTo.current && item.start < (instance.scrollOffset ?? 0);

  keepPlace.current = () => {
    // Mid-restore the scrolling is ours, not yours — recording it would
    // overwrite the place we're on the way back to.
    if (!sessionId || !scrollEl || restoreTo.current) return;
    const a: Anchor | null = stick.current ? "bottom" : anchorAt(
      virtualizer.getVirtualItems()
        .map((v) => ({ key: String(v.key), start: v.start, end: v.end })),
      scrollEl.scrollTop);
    if (a) remember(sessionId, a);
  };

  const applyRestore = () => {
    const a = restoreTo.current;
    if (!a || a === "bottom" || !scrollEl) return;
    const i = visibleTurns.findIndex((t) => t.id === a.turn);
    if (i < 0) return;
    const top = virtualizer.getOffsetForIndex(i, "start");
    if (top) scrollEl.scrollTop = top[0] + a.off;
  };

  // The other half: once the turns are on screen and the list has been measured
  // against the scroller (listOffset — row coordinates are wrong without it),
  // scroll back to the turn you were on. A turn we can't find didn't come with
  // the tail, and the bottom is the honest answer to "that place is gone".
  useEffect(() => {
    const a = restoreTo.current;
    if (!a || a === "bottom" || loadingSession || !scrollEl || !listOffset
        || !visibleTurns.length) return;
    if (!visibleTurns.some((t) => t.id === a.turn)) {
      endRestore();
      stick.current = true;
      setParked(true);
      toBottom();
      return;
    }
    if (!restoreT.current) restoreT.current = window.setTimeout(endRestore, 2000);
    applyRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyRestore reads refs + this render's rows
  }, [visibleTurns, loadingSession, scrollEl, listOffset, virtualizer, toBottom, endRestore]);

  // Rows measure after they mount, which re-renders this page and moves the
  // anchor's pixel — so re-aim on every render until the window closes.
  useEffect(() => { if (restoreTo.current) applyRestore(); });

  // Let the checkpoints sheet (rendered from the root layout) navigate us.
  useEffect(() => {
    transcriptNav.current = {
      jumpToTurn: (turnId: string) => {
        const i = visibleTurns.findIndex((t) => t.id === turnId);
        if (i < 0) return false;
        virtualizer.scrollToIndex(i, { align: "start" });
        stick.current = false;
        setParked(false);
        return true;
      },
    };
    return () => { transcriptNav.current = null; };
  }, [visibleTurns, virtualizer, transcriptNav]);

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

      {hasOlder && (
        <div className="flex justify-center pb-1">
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={olderLoading}
            className="rounded-full border border-border px-3 py-1 text-[11px] tracking-[1px] text-[var(--tg-hint)] active:opacity-70 disabled:opacity-50"
          >
            {olderLoading ? "LOADING OLDER…" : "▲ LOAD OLDER TURNS"}
          </button>
        </div>
      )}

      {/* Virtualized turn list: only rows near the viewport are mounted. Row
          wrappers are translateY'd (why the lightbox portals to body); pb-3
          stands in for the list gap so measureElement counts row spacing. */}
      <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
        const turn = visibleTurns[vi.index];
        const i = vi.index;
        const isActive = turn.jobId === activeTurn?.jobId;
        const working = isActive && turn.status === "running" && activeTurn.pending.length === 0;
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            data-key={turn.id}
            ref={virtualizer.measureElement}
            className="pb-3"
            style={{ position: "absolute", top: 0, left: 0, width: "100%",
                     transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)` }}
          >
          {/* id: what a checkpoint scrolls to (CheckpointsSheet). */}
          <div id={`turn-${turn.id}`} className="space-y-2">
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
                    i === visibleTurns.length - 1 && turn.status === "done"
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
          </div>
        );
        })}
      </div>

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
