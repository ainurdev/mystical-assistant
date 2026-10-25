import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, type AccountInfo, type AnswerSelection, type RivendellJob, type SlashCommand, type TurnOutcome } from "../api";
import type { PendingRequest, Turn } from "../chat";
import type { HudSettings } from "../lib/theme";
import { RunStream, TURN_TAIL } from "./RunStream";
import { PromptBubble } from "./PromptBubble";
import { JobPlate } from "./JobPlate";
import { Markdown, type OpenFile } from "./Markdown";
import { ImageLightbox, MediaThumb, ZoomButton } from "./ImageLightbox";
import { ckId } from "../lib/checkpoints";
import { openSettings } from "../lib/opensettings";
import { updateClaude } from "../lib/restart";
import { anchorAt, type Anchor, type Rows } from "../lib/scrollmem";
import { hhmm, useClock12 } from "../lib/surfaces";
import { RuneSpirit } from "./hud/RuneSpirit";
import { UnfinishedPlate } from "./TeamBar";
import { LimitBlock, type LimitLive } from "./LimitCard";
import { limitNudge } from "../lib/limit";

// The plates draw a prompt that ran a /command as one (PromptBubble, lib/slash
// leadCommand), checked against the project's command list: read once per
// project and page, and shared by every plate.
// shortcut: a skill installed after the page loaded stays words on its plates
// until a reload; refresh this from the composer's re-read if that ever bites.
const cmdLists = new Map<string, Promise<SlashCommand[]>>();
function useCommands(project?: string | null): SlashCommand[] {
  const [cmds, setCmds] = useState<SlashCommand[]>([]);
  useEffect(() => {
    const key = project ?? "";
    let list = cmdLists.get(key);
    if (!list) {
      // A failed read isn't kept, so the next switch here tries again.
      list = api.commands(project).then((r) => r.commands, () => { cmdLists.delete(key); return []; });
      cmdLists.set(key, list);
    }
    let live = true;
    void list.then((c) => { if (live) setCmds(c); });
    return () => { live = false; };
  }, [project]);
  return cmds;
}

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
      {zoom && <ImageLightbox src={zoom} all={srcs.filter((s) => !gone.has(s)).map((src) => ({ src }))} onClose={() => setZoom(null)} />}
      <div className="flex max-w-[78%] flex-wrap items-center justify-end gap-2">
        {srcs.map((src, i) =>
          gone.has(src) ? null : (
            <ZoomButton key={i} onOpen={() => setZoom(src)}>
              <MediaThumb
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

/** Why a failed turn failed. The whole point of the feature: before this, an
 *  interrupted or silent turn rendered as literally nothing — no events, no
 *  runtime, so not even a row — and 384 error turns in the real store could not
 *  say which of them had actually delivered their answer. `delivered` and
 *  `interrupted` are good news, so they are not painted as errors. */
function OutcomeBadge({ outcome }: { outcome: TurnOutcome }) {
  const good = outcome.code === "delivered" || outcome.code === "interrupted";
  const tone = good ? "var(--warn)" : "var(--err)";
  return (
    <div className="doutcome ml-[var(--rail)] flex flex-col gap-0.5">
      <span
        className="self-start border px-1.5 py-px text-[length:var(--t95)] tracking-[1px]"
        style={{ color: tone, borderColor: "color-mix(in srgb, currentColor 40%, transparent)" }}
      >
        {good ? "◇ " : "✕ "}{outcome.label}
      </span>
      <span className="text-[length:var(--t95)] opacity-70" style={{ color: tone }}>
        {outcome.detail}
      </span>
      {/* The detail says "check ACCOUNTS" and, until this button, left you to
       *  find them: the dead login is the one failure the user can fix from
       *  here, so the way in sits on the badge that reports it. */}
      {outcome.code === "auth" && (
        <button
          type="button"
          onClick={() => openSettings("aimgmt")}
          className="mt-0.5 self-start border px-1.5 py-px text-[length:var(--t95)] tracking-[1px] hover:bg-accent"
          style={{ color: "var(--acc)", borderColor: "color-mix(in srgb, currentColor 40%, transparent)" }}
        >
          OPEN SETTINGS ▸ ACCOUNTS
        </button>
      )}
      {outcome.code === "outdated" && (
        <button
          type="button"
          onClick={() => void updateClaude()}
          className="mt-0.5 self-start border px-1.5 py-px text-[length:var(--t95)] tracking-[1px] hover:bg-accent"
          style={{ color: "var(--acc)", borderColor: "color-mix(in srgb, currentColor 40%, transparent)" }}
        >
          UPDATE CLAUDE & RESTART
        </button>
      )}
    </div>
  );
}

/** The agent's side of the chat: a hairline down the 18px gutter every card in a
 *  turn already indents past. The diamonds on it belong to the messages — each
 *  prose bubble and the RESULT box draws its own where it starts (RailNode in
 *  RunStream) — so the rail marks where the agent spoke, not just that it did.
 *  Drawn in WIRE only: the Chat Elements sheet gives the spine to 2A alone, and
 *  the other four say the same thing their own way (a stamped edge, a 3px rule
 *  on the row, a §, or nothing). */
export function AgentRail() {
  return (
    // Flat, not a gradient: a turn runs to thousands of pixels, so anything
    // that fades out is invisible for most of its own length.
    // Geometry and colour both live in .agent-rail (index.css): the spine is
    // 2A WIRE's, and a language cannot take it off an inline rule.
    <span aria-hidden className="agent-rail" />
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
  turn, prev, next, isActive, isLast, promptIdx, hud, liveTurns, boot, who, unfinishedBy,
  onRespond, onRunCommand, onQuote, onOpenFile, onAnswer, askDocked, job, jobTitle, cmds, limit, logins,
}: {
  turn: Turn;
  /** The turn before it, whose run your prompt's tag compares against. */
  prev?: Turn;
  /** The turn after it: a usage limit's receipt says how the work went on. */
  next?: Turn;
  /** The open session parked on a usage limit — on the last turn only. */
  limit?: LimitLive | null;
  /** The Claude logins, so a limit can name them. */
  logins: AccountInfo[];
  /** The project's command list, for the plate (useCommands). */
  cmds: SlashCommand[];
  /** The teammate whose device run this turn is: their name signs the prompt,
   *  in the device-run blue. */
  who?: string;
  /** Who sent this session while this turn was still running: it says so where its answer would be. */
  unfinishedBy?: string;
  isActive: boolean;
  /** What the live turn is waiting on before its first token, or null. */
  boot?: string | null;
  isLast: boolean;
  /** Index into the session's turns — what the sticky peek reads to name
   *  the turn the top edge is inside. */
  promptIdx: number;
  hud?: HudSettings;
  liveTurns?: Set<string>;
  onRespond: Respond;
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: OpenFile;
  onAnswer?: (text: string) => void;
  askDocked?: boolean;
  /** The Rivendell job behind the session (lib/jobs), on its first turn only. */
  job?: RivendellJob | null;
  jobTitle?: string | null;
}) {
  const working = isActive && turn.status === "running" && turn.pending.length === 0;
  // Stable, so RunStream's memo holds across polls.
  // The job arrives as a new object each poll, so it is keyed by its contents.
  const jobKey = job?.kind ? JSON.stringify(job) : "";
  const view = useMemo(() => (jobKey ? { job: JSON.parse(jobKey) as RivendellJob, prompt: turn.prompt } : null), [jobKey, turn.prompt]);
  const replied = turn.events.length > 0 || turn.status === "running" || !!turn.runtime;
  // Sent from this page a moment ago: your prompt rises into place, its WORK
  // card a beat behind (RunStream). Read at mount, so a turn you come back to is
  // simply there.
  const [sent] = useState(() => !!liveTurns?.has(turn.id) && turn.status === "running" && !turn.events.length);
  // The usage limit (LimitCard): the turn it cut off gives its error answer and
  // badge to the limit's card or receipt, and a turn the bridge sent to carry the
  // work on draws no plate — those words aren't yours. The two then read as one
  // stretch of work (data-limit / data-cont in index.css).
  const limitHit = turn.outcome?.code === "limit";
  const nudge = limitNudge(turn.prompt);
  const events = useMemo(() => {
    if (!limitHit) return turn.events;
    // The CLI's sentence comes as the error result, and often as a text event too.
    const said = new Set(turn.events.flatMap((e) => (e.type === "result" && e.is_error ? [e.result.trim()] : [])));
    return turn.events.filter((e) => !(e.type === "result" && e.is_error)
      && !(e.type === "error" && /limit/i.test(e.message))
      && !(e.type === "text" && said.has(e.text.trim())));
  }, [turn.events, limitHit]);
  return (
    // data-ctx-*: the dashboard's right-click menu reads the nearest one of
    // these off the target chain, so a click anywhere inside a turn resolves to
    // that turn rather than the terminal pane wrapping it.
    // `dturn` / `dprompt` / `dreply` are inert outside DOSSIER (display:contents
    // on the wrapper), where they make a turn one card: prompt, work, answer.
    <div id={ckId(turn.id)} className="dturn flex flex-col gap-2 scroll-mt-[86px]"
      data-ctx-type="turn" data-ctx-id={turn.id} data-last={isLast || undefined}
      data-limit={limitHit && limitNudge(next?.prompt) ? "" : undefined} data-cont={nudge ? "" : undefined}
      data-ctx-label={(turn.prompt || "reply").replace(/\s+/g, " ").slice(0, 60)}>
      <div className="dprompt" data-job={job ? "" : undefined} data-who={who ? "" : undefined}
        style={sent ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}>
        {turn.prompt && !nudge && (
          <div data-prompt-idx={promptIdx}>
            {job ? <JobPlate job={job} prompt={turn.prompt} at={turn.started} title={jobTitle} />
              : <PromptBubble text={turn.prompt} at={turn.started} runtime={turn.runtime} run={turn} prev={prev} commands={cmds} who={who} />}
          </div>
        )}
        {turn.attachments && turn.attachments.length > 0 && (
          <Attachments items={turn.attachments} />
        )}
      </div>
      {/* position:relative is safe here — the ImageLightbox portals to body. */}
      {replied && (
        <div className="dreply relative space-y-1.5">
          <AgentRail />
          {(events.length > 0 || turn.status === "running") && (
            <RunStream
              events={events}
              boot={isActive ? boot : null}
              pending={turn.pending as PendingRequest[]}
              onRespond={isActive ? onRespond : undefined}
              animate={liveTurns?.has(turn.id) ?? false}
              turnId={turn.id}
              tokens={turn.tokens ?? null}
              openResults={hud?.openResults ?? false}
              foldsOpen={hud?.foldsOpen ?? false}
              compact={hud?.layout === "compact"}
              turnStarted={turn.started}
              onRunCommand={onRunCommand}
              onQuote={onQuote}
              onOpenFile={onOpenFile}
              // Only the last finished turn can be replied to — a chip on an
              // older answer would send its question back out of order.
              onAnswer={isLast && turn.status === "done" ? onAnswer : undefined}
              askDocked={askDocked}
              ended={turn.status !== "running"}
              unfinished={!!unfinishedBy}
              readOnly={!!who}
              working={working}
              hud={hud}
              view={view}
            />
          )}
        </div>
      )}
      {limitHit ? <LimitBlock turn={turn} next={next} live={limit} logins={logins} />
        : turn.outcome && <OutcomeBadge outcome={turn.outcome} />}
      {unfinishedBy && <UnfinishedPlate who={unfinishedBy} />}
    </div>
  );
}

type Row = { kind: "turn"; turn: Turn } | { kind: "working" };

const NO_LOGINS: AccountInfo[] = [];
const NO_EVENTS: Turn["events"] = [];

/** Imperative surface for checkpoint navigation — the virtualized list can't
 *  be driven by getElementById, because the target usually isn't mounted. */
export interface TranscriptNav {
  /** Scroll a turn's row into view (then the sub-anchor inside it once
   *  mounted). false = the turn isn't in the rendered list — unloaded behind
   *  the tail cut, or unknown. */
  jumpToTurn: (turnId: string, subAnchorId?: string) => boolean;
  /** Row start offset in scroll coordinates; null when not in the list. */
  turnTop: (turnId: string) => number | null;
  /** Where the reader is right now, as something that survives a re-render of
   *  the whole list: null when there's nothing on screen to name. */
  anchor: () => Anchor | null;
}

export function Transcript({
  turns,
  activeId,
  boot,
  who,
  onRespond,
  liveTurns,
  trailingWorking,
  hud,
  onRunCommand,
  onQuote,
  onOpenFile,
  onAnswer,
  askDocked,
  hasOlder,
  olderLoading,
  onLoadOlder,
  renderFrom,
  scrollRef,
  sessionKey,
  navRef,
  restoringRef,
  correctingRef,
  job,
  jobTitle,
  project,
  top,
  unfinished,
  limit,
  logins = NO_LOGINS,
}: {
  turns: Turn[];
  activeId: string | null;
  /** What the live turn is waiting on before its first token, or null. */
  boot?: string | null;
  /** A teammate's device run: who asked, signing its first turn's prompt. */
  who?: string;
  onRespond: Respond;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
  hud?: HudSettings;
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: OpenFile;
  onAnswer?: (text: string) => void;
  /** The open ask sits on the prompt box (AskDock). */
  askDocked?: boolean;
  hasOlder?: boolean;
  olderLoading?: boolean;
  onLoadOlder?: () => void;
  renderFrom?: string | null;
  /** The scroller (Terminal's mscroll div) the virtualizer windows against. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Session identity — resets the ctrl-F full mount on switch. */
  sessionKey?: string | null;
  /** Filled with the checkpoint-navigation surface while mounted. */
  navRef?: MutableRefObject<TranscriptNav | null>;
  /** Non-null while the caller is scrolling back to a remembered place. */
  restoringRef?: RefObject<Anchor | null>;
  /** Set true for the frame after a scroll correction of ours — the scroll
   *  event it fires is not the reader's. */
  correctingRef?: MutableRefObject<boolean>;
  /** The Rivendell job behind this session, if one started it: its first turn
   *  draws as the job's plate (JobPlate). */
  job?: RivendellJob | null;
  jobTitle?: string | null;
  /** The session's project, whose command list the plates read. */
  project?: string | null;
  /** Above the first turn: a session a teammate sent shows the hop before theirs here. */
  top?: ReactNode;
  /** Turns still running when a teammate sent the session, and who sent it. */
  unfinished?: { turns: string[]; by: string } | null;
  /** The open session, when it is parked on a usage limit: its last turn's live card. */
  limit?: LimitLive | null;
  /** The Claude logins (/local/accounts), so a limit can name them. */
  logins?: AccountInfo[];
}) {
  const cmds = useCommands(project);
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
  // While a jump settles, scroll anchoring is off (see below). ponytail: a
  // deadline, not a "landed" signal — scrollToIndex doesn't report one.
  const jumpT = useRef(0);
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
      // Capped: a turn's work sits in zones that are shut unless opened, so a
      // 400-event turn draws nothing like 400 rows and its full length would
      // guess ~7x too tall.
      ?? Math.min(20000, 80 + (rows[i].kind === "turn"
        ? Math.min(rows[i].turn.events.length, TURN_TAIL) * 20 : 0)),
    overscan: 2,
    // A jump aims a turn at the list's top, which sits under Terminal's content
    // padding (62px). This lowers it to 86px, clear of the header island with
    // its LAST row open: the line scroll-mt-[86px] draws for scrollIntoView.
    scrollPaddingStart: 24,
    measureElement: (el, entry) => {
      // LAYOUT size, never getBoundingClientRect: that one is post-transform,
      // and rows mount while the panel's entrance animation (enterZoom / mpop)
      // still has the column at scale(.9-.98). Every turn then cached ~3% short,
      // a transform settling fires no ResizeObserver to correct it, and each
      // turn slid up over the gap under it — 22px of spacing landing as 6-17.
      const h = entry?.borderBoxSize?.[0]?.blockSize ?? (el as HTMLElement).offsetHeight;
      const k = el.getAttribute("data-key");
      if (k) sizesRef.current.set(k, h);
      return h;
    },
  });
  // A row above the viewport re-measuring (streamed content settling, an image
  // loading) must not slide what you're reading — this is the replacement for
  // the hand-rolled scroll anchoring App.tsx used to do. An instance field in
  // @tanstack/virtual-core 3.14, not a constructor option.
  //
  // Except while we're scrolling back to a remembered place: the row you land
  // *inside* measures right after, and this correction reads that growth as
  // "content above you got taller" and pushes you the whole height of the turn —
  // to the bottom of a one-megaturn session. During a restore the anchor owns
  // the scroll position.
  //
  // A checkpoint jump is the same story: it aims at estimated offsets, the rows
  // it lands among mount and measure, and the overscan rows *above* the target
  // report the growth as "content above you got taller" — which walked a jump to
  // turn 5 down to turn 12. scrollToIndex re-aims itself as rows measure, so
  // it, not this, owns the scroll while a jump is settling.
  //
  // Only rows ENTIRELY above the top edge count as "above you". The live turn,
  // once taller than the viewport, starts above the edge and ends below it: its
  // streamed chunks land below you (nothing above moved, yet this pushed you
  // down by each one), and a fold shutting above the edge is already compensated
  // by the browser's own scroll anchoring — in-flow content inside a row is its
  // job, and doing it again here threw the view up by twice the fold, to the
  // very top of a short session. Measured on the live dashboard: a 200px shrink
  // above the edge moved the view 400px. A row re-placed by `top` doesn't
  // trigger the browser's anchoring (an ancestor's `top` changing suppresses
  // it; measured in Chrome and WebKit), so the fully-above case is ours alone.
  //
  // And only against a scroll offset the virtualizer actually has: it learns
  // the position from scroll events, which land a frame after App sets
  // scrollTop on a landing or a jump. A correction computed against the
  // previous session's offset scrolled to (stale + delta), which clamped to the
  // top of the session just opened.
  //
  // Each correction is flagged for App's follow policy (correctingRef): the
  // scroll event it fires is ours, not a gesture to stop following on.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const el = scrollRef?.current;
    const offset = instance.scrollOffset;
    if (restoringRef?.current || Date.now() <= jumpT.current || !el || offset == null) return false;
    if (Math.abs(offset - el.scrollTop) > 1) return false;
    if (item.end > offset) return false;
    if (correctingRef) {
      correctingRef.current = true;
      // The scroll event lands in the next frame; a correction clamped to no
      // movement fires none, so the flag must not wait for one.
      requestAnimationFrame(() => requestAnimationFrame(() => { correctingRef.current = false; }));
    }
    return true;
  };

  // Checkpoint navigation. In full-mount mode everything is in the DOM, so the
  // plain scrollIntoView path is both available and exact; windowed, the row is
  // scrolled to by index and the sub-anchor refined once it has mounted.
  useEffect(() => {
    if (!navRef) return;
    const rowIndex = (turnId: string) =>
      rows.findIndex((r) => r.kind === "turn" && r.turn.id === turnId);
    // Full mount (ctrl-F) has every row in the DOM and no virtual items, so the
    // two readers below measure rects instead — reported in the same frame the
    // virtualizer uses, i.e. against the content origin rather than the viewport.
    // Without this both returned null, so a find left the place unsaved and the
    // next session switch landed at the bottom.
    const domRows = (el: HTMLElement): Rows => {
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      return [...el.querySelectorAll<HTMLElement>("[data-key]")].map((r) => {
        const b = r.getBoundingClientRect();
        return { key: r.getAttribute("data-key") ?? "", start: b.top - origin, end: b.bottom - origin };
      });
    };
    navRef.current = {
      jumpToTurn: (turnId, subAnchorId) => {
        jumpT.current = Date.now() + 1000;
        if (fullRef.current) {
          const el = document.getElementById(subAnchorId ?? ckId(turnId));
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
          return !!el;
        }
        const i = rowIndex(turnId);
        if (i < 0) return false;
        virtualizer.scrollToIndex(i, { align: "start" });
        if (subAnchorId)
          requestAnimationFrame(() => requestAnimationFrame(() => {
            document.getElementById(subAnchorId)?.scrollIntoView({ block: "start" });
          }));
        return true;
      },
      turnTop: (turnId) => {
        const el = scrollRef?.current;
        if (fullRef.current)
          return el ? domRows(el).find((r) => r.key === turnId)?.start ?? null : null;
        const i = rowIndex(turnId);
        if (i < 0) return null;
        const off = virtualizer.getOffsetForIndex(i, "start");
        return off ? off[0] : null;
      },
      anchor: () => {
        const el = scrollRef?.current;
        if (!el) return null;
        return anchorAt(
          fullRef.current ? domRows(el) : virtualizer.getVirtualItems()
            .map((v) => ({ key: String(v.key), start: v.start, end: v.end })),
          el.scrollTop);
      },
    };
    return () => { navRef.current = null; };
  }, [navRef, rows, virtualizer]);

  if (!turns.length) {
    return <RuneSpirit variant="block" />;
  }

  const blockFor = (row: Row, index: number) =>
    row.kind === "turn" ? (
      <TurnBlock
        turn={row.turn}
        prev={turns[cut + index - 1]}
        next={turns[cut + index + 1]}
        limit={row.turn.id === turns[turns.length - 1]?.id ? limit : null}
        logins={logins}
        isActive={row.turn.id === activeId}
        boot={boot}
        isLast={index === visible.length - 1}
        promptIdx={cut + index}
        job={cut + index === 0 ? job : null}
        jobTitle={jobTitle}
        cmds={cmds}
        who={row.turn.id === turns[0]?.id ? who : undefined}
        unfinishedBy={unfinished?.turns.includes(row.turn.id) ? unfinished.by : undefined}
        hud={hud}
        liveTurns={liveTurns}
        onRespond={onRespond}
        onRunCommand={onRunCommand}
        onQuote={onQuote}
        onOpenFile={onOpenFile}
        onAnswer={onAnswer}
        askDocked={askDocked}
      />
    ) : (
      // Working with no running turn to hang it on (a native session's run, or a
      // queued prompt the next poll brings): the live WORK card, empty.
      <RunStream events={NO_EVENTS} working boot="working" hud={hud} animate />
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
        {top}
        {olderButton}
        {rows.map((row, i) => (
          <div key={keyOf(row)} data-key={keyOf(row)}>{blockFor(row, i)}</div>
        ))}
      </div>
    );
  }

  // Virtualized: only the rows near the viewport exist. A row is placed by
  // `top`, never translateY: browsers resolve position: sticky without
  // transforms, so inside a row translated by its start an open WORK zone's
  // header (index.css) pinned that many px early and rode its zone's foot. pb-3
  // lives on the wrapper (absolute rows can't share a flex gap) so
  // measureElement counts the spacing a row owns.
  return (
    <>
      {top}
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
              style={{ position: "absolute", top: vi.start, left: 0, width: "100%" }}
            >
              {blockFor(row, vi.index)}
            </div>
          );
        })}
      </div>
    </>
  );
}
