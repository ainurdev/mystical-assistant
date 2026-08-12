import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
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

/** One turn, exactly as it has always rendered — prompt bubble, attachments,
 *  then everything the agent did hung off one rail. The virtualizer mounts and
 *  unmounts these whole; RunStream's own content-visibility cards keep the
 *  within-turn cost flat while one is mounted. */
function TurnBlock({
  turn, isActive, isLast, lastPromptRef, hud, liveTurns,
  onRespond, onRunCommand, onQuote, onOpenFile, onAnswer,
}: {
  turn: Turn;
  isActive: boolean;
  isLast: boolean;
  lastPromptRef?: RefObject<HTMLDivElement | null>;
  hud?: HudSettings;
  liveTurns?: Set<string>;
  onRespond: Respond;
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onAnswer?: (text: string) => void;
}) {
  const working = isActive && turn.status === "running" && turn.pending.length === 0;
  const replied = turn.events.length > 0 || turn.status === "running" || !!turn.runtime;
  return (
    <div id={ckId(turn.id)} className="flex flex-col gap-2 scroll-mt-2">
      {turn.prompt && (
        <div ref={isLast ? lastPromptRef : undefined}>
          <PromptBubble text={turn.prompt} />
        </div>
      )}
      {turn.attachments && turn.attachments.length > 0 && (
        <Attachments items={turn.attachments} />
      )}
      {/* position:relative is safe here — the ImageLightbox portals to body. */}
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
}

type Row = { kind: "turn"; turn: Turn } | { kind: "working" };

export function Transcript({
  turns,
  activeId,
  onRespond,
  liveTurns,
  trailingWorking,
  lastPromptRef,
  hud,
  onRunCommand,
  onQuote,
  onOpenFile,
  onAnswer,
  hasOlder,
  olderLoading,
  onLoadOlder,
  renderFrom,
  scrollRef,
  sessionKey,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
  lastPromptRef?: RefObject<HTMLDivElement | null>;
  hud?: HudSettings;
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onAnswer?: (text: string) => void;
  hasOlder?: boolean;
  olderLoading?: boolean;
  onLoadOlder?: () => void;
  renderFrom?: string | null;
  /** The scroller (Terminal's mscroll div) the virtualizer windows against. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Session identity — resets the ctrl-F full mount on switch. */
  sessionKey?: string | null;
}) {
  // Tail loading: turns always ship whole but only the last few carry events.
  // Turns before the cut would render as prompt bubbles with missing bodies —
  // worse than absent — so they hide behind the "load older" control.
  const cut = renderFrom ? turns.findIndex((t) => t.id === renderFrom) : 0;
  const visible = cut > 0 ? turns.slice(cut) : turns;

  const rows = useMemo<Row[]>(() => {
    const r: Row[] = visible.map((turn) => ({ kind: "turn", turn }));
    // Native (VS Code) live session: no turn is ever "running", so the working
    // state comes from the unified status map instead of turn.status.
    if (trailingWorking) r.push({ kind: "working" });
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visible derives from turns+renderFrom
  }, [turns, renderFrom, trailingWorking]);

  // Measured heights survive unmount so a revisited turn is estimated exactly
  // right — the same "wrong only once" property content-visibility gave the
  // cards, one level up. Keyed by turn id, so it also survives session switches
  // back and forth within one mount.
  const sizesRef = useRef(new Map<string, number>());
  const keyOf = (r: Row) => (r.kind === "turn" ? r.turn.id : "__working");

  // Ctrl-F escape hatch: browser find only sees mounted rows, so the shortcut
  // mounts everything (synchronously, so the DOM is complete before the find
  // bar opens) and Escape or a session switch returns to the windowed list.
  const [fullMount, setFullMount] = useState(false);
  const fullRef = useRef(fullMount);
  fullRef.current = fullMount;
  useEffect(() => { setFullMount(false); }, [sessionKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        if (!fullRef.current) flushSync(() => setFullMount(true));
      } else if (e.key === "Escape" && fullRef.current) {
        setFullMount(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef?.current ?? null,
    getItemKey: (i) => keyOf(rows[i]),
    // ~20px/event: the 2608-event session measures 47k px, i.e. chip folding
    // compresses a turn to well under one card per event. The cache replaces
    // the guess with truth after first mount.
    estimateSize: (i) => sizesRef.current.get(keyOf(rows[i]))
      ?? Math.min(20000, 80 + (rows[i].kind === "turn" ? rows[i].turn.events.length * 20 : 0)),
    overscan: 2,
    measureElement: (el) => {
      const h = el.getBoundingClientRect().height;
      const k = el.getAttribute("data-key");
      if (k) sizesRef.current.set(k, h);
      return h;
    },
  });
  // A row above the viewport re-measuring (streamed content settling, an image
  // loading) must not slide what you're reading — this is the replacement for
  // the hand-rolled scroll anchoring App.tsx used to do. An instance field in
  // @tanstack/virtual-core 3.14, not a constructor option.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.start < (instance.scrollOffset ?? 0);

  if (!turns.length) {
    return <RuneSpirit variant="block" />;
  }

  const blockFor = (row: Row, index: number) =>
    row.kind === "turn" ? (
      <TurnBlock
        turn={row.turn}
        isActive={row.turn.id === activeId}
        isLast={index === visible.length - 1}
        lastPromptRef={lastPromptRef}
        hud={hud}
        liveTurns={liveTurns}
        onRespond={onRespond}
        onRunCommand={onRunCommand}
        onQuote={onQuote}
        onOpenFile={onOpenFile}
        onAnswer={onAnswer}
      />
    ) : (
      <WorkingIndicator hud={hud} />
    );

  const olderButton = hasOlder && (
    <div className="flex justify-center pb-1">
      <button
        type="button"
        onClick={onLoadOlder}
        disabled={olderLoading}
        className="border border-border px-3 py-1 text-[length:var(--t11)] tracking-[1px] text-muted-2 hover:text-foreground-bright disabled:opacity-50"
      >
        {olderLoading ? "LOADING OLDER…" : "▲ LOAD OLDER TURNS"}
      </button>
    </div>
  );

  // Full mount (ctrl-F): the list as it was before virtualization — every turn
  // in normal flow, cards' own content-visibility carrying the weight.
  if (fullMount || !scrollRef) {
    return (
      <div className="flex flex-col gap-3">
        {olderButton}
        {rows.map((row, i) => (
          <div key={keyOf(row)}>{blockFor(row, i)}</div>
        ))}
      </div>
    );
  }

  // Virtualized: only the rows near the viewport exist. Row wrappers are
  // translateY'd, which is why the lightbox portals to body, and pb-3 lives on
  // the wrapper (absolute rows can't share a flex gap) so measureElement counts
  // the spacing a row owns.
  return (
    <>
      {olderButton}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              data-key={keyOf(row)}
              ref={virtualizer.measureElement}
              className="pb-3"
              style={{ position: "absolute", top: 0, left: 0, width: "100%",
                       transform: `translateY(${vi.start}px)` }}
            >
              {blockFor(row, vi.index)}
            </div>
          );
        })}
      </div>
    </>
  );
}
