import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { type AnswerSelection, type DevServerInfo, type EnrichedSession, type NextItem, type SessionBrief } from "../../api";
import type { Turn } from "../../chat";
import type { Mark } from "../../lib/checkpoints";
import type { Anchor } from "../../lib/scrollmem";
import { projectName, projectTint } from "../../lib/surfaces";
import { chatPad, hairline } from "../../lib/shell";
import { useLoadingPhase } from "../../lib/loadingPhase";
import type { HudSettings } from "../../lib/theme";
import { Transcript, type TranscriptNav } from "../Transcript";
import type { OpenFile } from "../Markdown";
import { HistoryView } from "../HistoryView";
import { NextView } from "../NextView";
import { FreshPanel } from "../FreshPanel";
import { ViewTabs, type View } from "./ViewTabs";
import { Checkpoints, ScrollRail } from "./Checkpoints";
import { SpendPanel } from "./SpendPanel";
import { ChatChromeContext } from "../../lib/chatchrome";

/** The header is an island this far in from the chat column's top and sides;
 *  16 clears the ScrollRail on the right edge. */
const ISLE_TOP = 8, ISLE_X = 16;
/** The island's bottom with only its header row: where a prompt counts as
 *  passed, the moment the island starts covering it. Parked at the top nothing
 *  has, so the LAST row stays folded. */
const ISLE_EDGE = ISLE_TOP + 40 + 2;
/** Height of the LAST row the island opens once a prompt has slid under it.
 *  Open, the island covers ISLE_EDGE + PEEK_H of the scroller: what
 *  `scroll-mt-[86px]` on the transcript's anchors (RunStream's: 94) clears. */
const PEEK_H = 28;

const FRESH_QUOTES = [
  "the prompt is blank, the potential is not.",
  "speak, and I shall translate intent into diffs.",
  "idle, but never asleep — what shall we ship?",
  "every great commit starts with an empty line.",
  "no tasks queued; the oracle grows restless.",
  "feed me an error and watch the sparks fly.",
  "a quiet terminal is a dangerous thing. let us fix that.",
  "ready to conjure — name your bug.",
];

function basename(rel: string | null | undefined): string | null {
  if (!rel) return null;
  const clean = rel.replace(/\/+$/, "");
  if (clean === "" || clean === "/") return "/";
  return projectName(clean);
}

// The assistant's idle expressions. Eyes + mouth are simple glowing primitives;
// faces are crossfaded (not morphed) so any shape pairs read smoothly.
const FACE_TEAL = "var(--acc)";
const EYE_GLOW = "0 0 8px var(--acc)";
type EyeV = "open" | "round" | "line" | "happy";
type MouthV = "smile" | "grin" | "flat" | "o";

function Eye({ v }: { v: EyeV }) {
  if (v === "happy") // an upward ∩ arc — a content squint
    return <span style={{ width: 13, height: 7, border: `2px solid ${FACE_TEAL}`, borderBottom: 0, borderRadius: "11px 11px 0 0", boxShadow: EYE_GLOW }} />;
  if (v === "line")
    return <span style={{ width: 12, height: 3, borderRadius: 3, background: FACE_TEAL, boxShadow: EYE_GLOW }} />;
  if (v === "round")
    return <span style={{ width: 12, height: 12, borderRadius: "50%", background: FACE_TEAL, boxShadow: EYE_GLOW, animation: "eyeblink 5s infinite" }} />;
  return <span style={{ width: 9, height: 13, borderRadius: 3, background: FACE_TEAL, boxShadow: EYE_GLOW, animation: "eyeblink 5s infinite" }} />;
}
function Mouth({ v }: { v: MouthV }) {
  if (v === "o")
    return <span style={{ width: 9, height: 9, border: `2px solid ${FACE_TEAL}`, borderRadius: "50%", opacity: 0.9 }} />;
  if (v === "flat")
    return <span style={{ width: 16, height: 2, borderRadius: 2, background: FACE_TEAL, opacity: 0.75 }} />;
  if (v === "grin")
    return <span style={{ width: 26, height: 13, border: `2px solid ${FACE_TEAL}`, borderTop: 0, borderRadius: "0 0 16px 16px", opacity: 0.9 }} />;
  return <span style={{ width: 22, height: 10, border: `2px solid ${FACE_TEAL}`, borderTop: 0, borderRadius: "0 0 14px 14px", opacity: 0.85 }} />;
}
const FACES: { eyeL: EyeV; eyeR: EyeV; mouth: MouthV }[] = [
  { eyeL: "open", eyeR: "open", mouth: "smile" },   // friendly
  { eyeL: "happy", eyeR: "happy", mouth: "grin" },  // delighted
  { eyeL: "round", eyeR: "round", mouth: "o" },     // curious
  { eyeL: "line", eyeR: "line", mouth: "flat" },    // calm
  { eyeL: "open", eyeR: "line", mouth: "smile" },   // a wink
];

/** The empty-session intro: the mystical assistant face, a rotating quote and
 *  a blinking "awaiting your command" caret, then FreshPanel — where the
 *  project stands and what to start next. Mounted whenever a project is
 *  known; unlike the strips it replaced, it does not wait on an AI switch. */
function FreshState({ project, branch, run, onOpenRun, onStartNext }: {
  project: string | null;
  branch?: string | null;
  run?: DevServerInfo | null;
  onOpenRun?: () => void;
  onStartNext: (item: NextItem) => void;
}) {
  const [qi, setQi] = useState(0);
  const [face, setFace] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQi((q) => q + 1), 7200);
    return () => clearInterval(id);
  }, []);
  // Drift through expressions on a long, unhurried interval.
  useEffect(() => {
    const id = setInterval(() => setFace((f) => (f + 1) % FACES.length), 10000);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ height: "100%", minHeight: 330, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, textAlign: "center", animation: "mfadeup .5s ease both" }}>
      <div style={{ position: "relative", width: 112, height: 112, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", opacity: 0.5 }}>
          <circle cx="50" cy="50" r="46" fill="none" stroke="var(--acc)" strokeWidth="1" strokeDasharray="5 9" style={{ transformOrigin: "50px 50px", animation: "introspin 11s linear infinite" }} />
          <circle cx="50" cy="50" r="38" fill="none" stroke="color-mix(in srgb, var(--purple) 40%, transparent)" strokeWidth="1" strokeDasharray="3 13" style={{ transformOrigin: "50px 50px", animation: "introspinr 16s linear infinite" }} />
        </svg>
        <div style={{ position: "relative", width: 72, height: 72, borderRadius: "50%", border: "1.5px solid color-mix(in srgb, var(--acc) 50%, transparent)", background: "radial-gradient(circle at 50% 36%,color-mix(in srgb, var(--acc) 16%, transparent),color-mix(in srgb, var(--panel2) 60%, transparent))", boxShadow: "0 0 28px color-mix(in srgb, var(--acc) 18%, transparent),inset 0 0 22px color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, animation: "bob 4.5s ease-in-out infinite" }}>
          {/* Expressions are stacked and crossfaded so the face dissolves
              between moods on the 10s interval rather than popping. */}
          <div style={{ position: "relative", width: 60, height: 42 }}>
            {FACES.map((f, i) => (
              <div key={i} aria-hidden style={{
                position: "absolute", inset: 0, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 9,
                opacity: i === face ? 1 : 0, transition: "opacity 1.3s ease",
              }}>
                <div style={{ display: "flex", gap: 16, alignItems: "center", height: 14 }}>
                  <Eye v={f.eyeL} /><Eye v={f.eyeR} />
                </div>
                <Mouth v={f.mouth} />
              </div>
            ))}
          </div>
        </div>
        <span style={{ position: "absolute", top: 4, right: 8, color: "var(--purple)", fontSize: "var(--t13)", animation: "twinkle 3s infinite" }}>✦</span>
        <span style={{ position: "absolute", bottom: 10, left: 4, color: "var(--acc)", fontSize: "var(--t10)", animation: "twinkle 4s infinite .5s" }}>✦</span>
        <span style={{ position: "absolute", top: 26, left: -2, color: "var(--ok)", fontSize: "var(--t9)", animation: "twinkle 3.5s infinite 1s" }}>+</span>
      </div>
      <div style={{ maxWidth: 450 }}>
        <div style={{ fontSize: "var(--t95)", letterSpacing: 3, color: "var(--txl)", marginBottom: 13 }}>
          {(basename(project) || "WORKSPACE").toUpperCase()} · FRESH SESSION
        </div>
        <div style={{ fontSize: "var(--t16)", lineHeight: 1.55, color: "var(--txh)", fontStyle: "italic", minHeight: 50 }}>
          <span key={qi} style={{ display: "inline-block", animation: "quotein .75s cubic-bezier(.2,.85,.25,1) both, quoteglow 7.2s ease-in-out infinite" }}>
            “{FRESH_QUOTES[qi % FRESH_QUOTES.length]}”
          </span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)" }}>
        <span style={{ color: "var(--purple)" }}>~ ❯</span>
        <span style={{ letterSpacing: 2, background: "linear-gradient(90deg,var(--txl) 0%,var(--txl) 28%,#9fe9dd 50%,var(--txl) 72%,var(--txl) 100%)", backgroundSize: "200% 100%", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", animation: "awaitsweep 3s linear infinite" }}>awaiting your command</span>
        <span style={{ width: 7, height: 14, background: "var(--acc)", display: "inline-block", boxShadow: "0 0 8px color-mix(in srgb, var(--acc) 70%, transparent)", animation: "caretbreath 1.5s ease-in-out infinite" }} />
      </div>
      {project && (
        <FreshPanel project={project} branch={branch} run={run}
                    onOpenRun={onOpenRun} onStart={onStartNext} />
      )}
    </div>
  );
}

/** The "channel tuning" loading state: a held, unstable scanline (the collapsed
 *  channel) that stays until the transcript is ready — then the viewport blooms open.
 *  Replaces a spinner so the channel-change transition spans the whole load.
 *
 *  `step` names the wait when we know it (a worktree being cut, a child starting):
 *  seconds of "TUNING SIGNAL…" reads as a hang, the same reason RunStream's boot
 *  row exists. Without one it stays generic. */
function ChannelTuning({ step }: { step?: string | null }) {
  return (
    <div style={{ height: "100%", minHeight: 330, position: "relative", overflow: "hidden", animation: "mfadeup .3s ease both" }}>
      <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 2, transform: "translateY(-50%)", background: "var(--acc)", boxShadow: "0 0 20px 2px color-mix(in srgb, var(--acc) 80%, transparent), 0 0 4px var(--acc)", animation: "chanline 1.15s ease-in-out infinite" }} />
      <span style={{ position: "absolute", left: 0, right: 0, top: "calc(50% + 30px)", textAlign: "center", fontSize: "var(--t10)", letterSpacing: 3, background: "linear-gradient(90deg,var(--txl) 0%,var(--txl) 28%,#9fe9dd 50%,var(--txl) 72%,var(--txl) 100%)", backgroundSize: "200% 100%", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", animation: "awaitsweep 2.4s linear infinite", textTransform: "uppercase" }}>{step || "TUNING SIGNAL…"}</span>
    </div>
  );
}

/** The project's running app, in the header's caption. A dev server the bridge
 *  owns (the RUN bar, or the model's Run tool) is the one thing about this session
 *  that is alive outside the transcript — so it says the port and opens the
 *  TERMINAL tab, which is where its logs and the STOP button live. */
function RunChip({ run, onClick }: { run: DevServerInfo; onClick?: () => void }) {
  const [hov, setHov] = useState(false);
  const live = run.status === "running";
  const c = live ? "var(--ok)" : "var(--err)";
  return (
    <button
      onClick={onClick} disabled={!onClick}
      title={`${live ? "running" : "exited"}${run.cmd ? ` · ${run.cmd}` : ""} — open the terminal`}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, flex: "none",
        fontFamily: "var(--mono)", fontSize: "var(--t9)", padding: 0, border: 0,
        appearance: "none", background: "transparent", cursor: onClick ? "pointer" : "default",
        color: hov ? "var(--txb)" : c,
      }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: c, flex: "none", boxShadow: live ? `0 0 6px ${c}` : "none", animation: live ? "caretbreath 2s ease-in-out infinite" : "none" }} />
      {live ? (run.port ? `:${run.port}` : "RUNNING") : "EXITED"}
    </button>
  );
}

export function Terminal({
  view, onView, selected, activeProject, branch, turns, activeId, onRespond,
  scrollRef, contentRef, atBottom, onJumpBottom, composer, onOpenFromHistory, onStartNext,
  liveTurns, trailingWorking, boot,
  loading, sessionId, hud, onRunCommand, onQuote, onOpenFile, onAnswer,
  hasOlder, olderLoading, onLoadOlder, renderFrom, navRef, restoringRef, onJumpMark,
  onOpenProject, run, onOpenRun, onDropFiles, chrome, gridRow,
}: {
  view: View;
  onView: (v: View) => void;
  selected: SessionBrief | null;
  activeProject?: string | null;
  branch?: string | null;
  model: string;
  turnCount: number;
  turns: Turn[];
  activeId: string | null;
  onRespond: (requestId: string, opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] }) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  onJumpBottom: () => void;
  composer: ReactNode;
  onOpenFromHistory: (s: EnrichedSession) => void;
  onStartNext: (item: NextItem) => void;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
  /** What the live turn is waiting on before its first token, or null. */
  boot?: string | null;
  loading?: boolean;
  sessionId?: string | null;
  hud?: HudSettings;
  /** Older turns exist server-side; render the "load older" control. */
  hasOlder?: boolean;
  olderLoading?: boolean;
  onLoadOlder?: () => void;
  /** First turn whose events are loaded — turns before it stay hidden. */
  renderFrom?: string | null;
  /** Checkpoint navigation surface, filled by the Transcript while mounted. */
  navRef?: MutableRefObject<TranscriptNav | null>;
  restoringRef?: RefObject<Anchor | null>;
  /** Jump to a checkpoint, auto-loading older pages when it isn't loaded. */
  onJumpMark?: (m: Mark) => void;
  /** Re-run a transcript command in this project's TERMINAL tab. */
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: OpenFile;
  onAnswer?: (text: string) => void;
  /** Move a typed session's stage — the rail's jumps and a gate's APPROVE. */
  /** Open a fresh typed session from a report card (PROBE -> FIX, and friends). */
  /** Open the project modal on its default tab. */
  onOpenProject?: () => void;
  /** The dev server the bridge is running for this project, if any. */
  run?: DevServerInfo | null;
  /** Open this project's TERMINAL tab (the run bar, logs and STOP). */
  onOpenRun?: () => void;
  /** Files dropped on a fresh session's screen — the composer's attachments. */
  onDropFiles?: (files: FileList) => void;
  /** Shell chrome folded in at the header's end — SHIP, the radio, clock &
   *  weather, the bell — while the right panel is collapsed to its rail and
   *  its column has no room for them. */
  chrome?: ReactNode;
  /** The shell grid rows the chat spans — the footer track too, when nothing
   *  sits under it. */
  gridRow?: string;
}) {
  const sessionProject = selected?.project ?? activeProject ?? null;
  const tint = projectTint(sessionProject);
  const projectLabel = basename(sessionProject);
  const [projHov, setProjHov] = useState(false);
  const [brHov, setBrHov] = useState(false);
  const [titleHov, setTitleHov] = useState(false);
  const [projBtnHov, setProjBtnHov] = useState(false);
  const [cntHov, setCntHov] = useState(false);
  const isChat = view === "chat";
  const empty = isChat && turns.length === 0;
  // COMPACT: the nameplate leaves the header for the composer's control row,
  // and the header shrinks to a pill of readouts on the right.
  const compact = hud?.layout === "compact";
  // A fresh session's whole screen is a drop target: a file dragged anywhere on
  // it lands where a drop on the prompt box would. Files only — a row or text
  // drag passes through untouched.
  const [dropping, setDropping] = useState(false);
  const fileDrag = (e: DragEvent) => empty && !!onDropFiles && e.dataTransfer.types.includes("Files");

  // The sticky peek names the turn you are *inside*: the last prompt that has
  // slid under the bar, not the session's last one. Two things fall out of that.
  // Scrolling back through an old turn peeks that turn's prompt, so the bar is a
  // section header rather than a permanent footnote about the tail. And at the
  // top of the transcript nothing has passed yet, so there is no bar to bury the
  // first message under. The cut-off is the bar's own bottom edge, so a prompt
  // counts as passed exactly when the island starts covering it.
  const [peekIdx, setPeekIdx] = useState<number | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    if (!isChat || empty || !root) { setPeekIdx(null); return; }
    let raf = 0;
    // Re-queried every measure rather than observed once: with the transcript
    // virtualized, prompts mount and unmount under you, and an observer bound to
    // one element goes stale the moment its row is recycled — which is exactly
    // how the old peek got stuck showing the tail at the top of the scroll.
    const measure = () => {
      raf = 0;
      const edge = root.getBoundingClientRect().top + ISLE_EDGE;
      let best: number | null = null;
      for (const el of root.querySelectorAll<HTMLElement>("[data-prompt-idx]")) {
        if (el.getBoundingClientRect().top >= edge) continue;
        const i = Number(el.dataset.promptIdx);
        if (best === null || i > best) best = i;
      }
      setPeekIdx(best);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    root.addEventListener("scroll", onScroll, { passive: true });
    // Streaming output grows the content under a pinned scroll position, which
    // moves prompts across the edge without a scroll event.
    const ro = new ResizeObserver(onScroll);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => {
      root.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, contentRef, view, empty, turns.length]);

  // What the bar says. Held past the point the bar hides so leaving the top of a
  // turn is a fade-out, not a blank bar sliding away.
  const held = useRef<{ text: string; label: string } | null>(null);
  const peeked = peekIdx !== null ? turns[peekIdx] : null;
  if (peeked?.prompt?.trim()) {
    held.current = {
      text: peeked.prompt.trim(),
      label: `${(peekIdx ?? 0) + 1}/${turns.length}`,
    };
  }
  const showPeek = !empty && peekIdx !== null && !!held.current;

  // Presentation only: whether the load has run long enough to be worth showing.
  // The retune below still gates on the raw `loading`, which is what actually
  // says the new transcript has landed.
  const slowLoad = useLoadingPhase(loading ?? false);

  // A session that takes a while to open would otherwise sit as the new header
  // over the old chat with nothing to say it is loading. Mark the swap on the
  // click commit and CSS dims the outgoing transcript and sweeps a hairline —
  // both on a delay, so an open that lands first is still the plain soft cut
  // below. `!loading` is what makes this order-independent with the release
  // effect: on the landing commit this one bails whichever runs first.
  const swapRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!isChat || !loading || empty) return; // empty: nothing worth holding
    const wrap = swapRef.current;
    if (wrap) wrap.dataset.swapping = "1";
  }, [sessionId, view, loading, empty]);

  // Session swap: the session you left stays on screen until the new transcript
  // lands (App holds its turns), then the new one fades up in its place. Fires on
  // content-land (loading→false), NOT on the click, so it's one soft cut instead of
  // a blank and a pop. Was a CRT retune — collapse to a scanline, bloom open with a
  // glitch — which read as a fault rather than a transition.
  const tunedFor = useRef<string | null>(null);
  const firstTune = useRef(true);
  useLayoutEffect(() => {
    if (!isChat || loading) return; // wait until the new transcript has landed
    // Release the hold in the same commit the new turns render in, so the dim
    // lifting and the fade-up below read as one motion.
    const wrap = swapRef.current;
    if (wrap) delete wrap.dataset.swapping;
    if (tunedFor.current === (sessionId ?? null)) return; // already retuned this session
    const el = scrollRef.current;
    if (!el) return;
    tunedFor.current = sessionId ?? null;
    if (firstTune.current) { firstTune.current = false; return; } // initial load: enterZoom covers it
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }, [sessionId, loading, view, scrollRef]);

  // The transcript itself, so both readings of it — the page and the board —
  // render the same scroller, the same virtualiser and the same rails.
  const body = (
    <div ref={swapRef} className="swapwrap" style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div aria-hidden className="swapline" />
      {dropping && (
        <div aria-hidden style={{ position: "absolute", inset: 10, zIndex: 7, pointerEvents: "none", display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 26, border: "1px dashed color-mix(in srgb, var(--acc) 55%, transparent)", background: "color-mix(in srgb, var(--acc) 5%, transparent)", fontSize: "var(--t10)", letterSpacing: 3, color: "var(--acc)" }}>
          DROP TO ATTACH
        </div>
      )}
      {/* OUTPUT STYLE is the whole session's idiom, not just its widgets: one
          attribute here and the ledger, the agent block, your prompt and the
          reply's own tables all answer to it (index.css, THE SESSION'S IDIOM). */}
      <div ref={scrollRef} data-style={hud?.toolStyle ?? "stamp"} className="mscroll mscroll-bare" style={{ flex: 1, minHeight: 0, padding: "0 18px", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t13)", lineHeight: 1.6, overflowWrap: "break-word" }}
        onDragOver={(e) => { if (!fileDrag(e)) return; e.preventDefault(); if (!dropping) setDropping(true); }}
        // relatedTarget is where the drag went: still inside, it only crossed a child
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(e) => { if (!fileDrag(e)) return; e.preventDefault(); setDropping(false); onDropFiles?.(e.dataTransfer.files); }}>
        {/* Top padding clears the island so the first prompt starts
            below it: parked at the top nothing has slid under it, so the
            LAST row stays folded and the transcript opens on its first
            message, not on a header repeating it. */}
        {/* SIGNAL LOG's schema line. A log names its columns once at the top,
            not once per turn, so it lives here and sticks; every other output
            style leaves it `display: none` (index.css, 2B · SIGNAL LOG). */}
        <div className="siglog-head" aria-hidden>
          <span>T+</span><span style={{ textAlign: "center" }}>LEVEL</span>
          <span>EVENT</span><span>RESULT</span><span />
        </div>
        <div ref={contentRef} style={{ padding: `${ISLE_EDGE + 12}px 0 16px` }}>
          {/* A switch that lands inside the delay renders neither: no
              scanline for a load that's already over, and no FreshState
              flashing in front of a transcript that's about to arrive. */}
          {empty && slowLoad ? (
            <ChannelTuning step={boot} />
          ) : empty && loading ? null : empty ? (
            <FreshState project={sessionProject} branch={branch} run={run} onOpenRun={onOpenRun} onStartNext={onStartNext} />
          ) : (
            <Transcript turns={turns} activeId={activeId} boot={boot} onRespond={onRespond} liveTurns={liveTurns} trailingWorking={trailingWorking} hud={hud} onRunCommand={onRunCommand} onQuote={onQuote} onOpenFile={onOpenFile} onAnswer={onAnswer} hasOlder={hasOlder} olderLoading={olderLoading} onLoadOlder={onLoadOlder} renderFrom={renderFrom} scrollRef={scrollRef} sessionKey={sessionId} navRef={navRef} restoringRef={restoringRef} />
          )}
        </div>
      </div>
      {!empty && <ScrollRail turns={turns} scrollRef={scrollRef} />}
      {/* Scrolled off the tail — the way back down. Hidden while parked at
          the bottom, where new output already follows on its own. Stays
          mounted and fades, so a toggle mid-scroll never pops or replays
          the mount animation. visibility drops it from the tab order and
          hit-testing while hidden. */}
      {!empty && (
        <button
          type="button" onClick={onJumpBottom} title="jump to latest"
          style={{
            position: "absolute", right: 20, bottom: 14, zIndex: 6,
            display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
            padding: "5px 10px", fontFamily: "'JetBrains Mono',monospace",
            fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--acc)",
            background: "color-mix(in srgb, var(--panel2) 92%, transparent)",
            border: "1px solid color-mix(in srgb, var(--acc) 34%, transparent)",
            boxShadow: "0 6px 20px rgba(0,0,0,.45), 0 0 14px color-mix(in srgb, var(--acc) 14%, transparent)",
            backdropFilter: "blur(6px)",
            opacity: atBottom ? 0 : 1,
            transform: atBottom ? "translateY(5px)" : "none",
            visibility: atBottom ? "hidden" : "visible",
            transition: "opacity .22s ease, transform .22s ease, visibility .22s",
          }}
        >
          <span style={{ fontSize: "var(--t11)", lineHeight: 1 }}>↓</span>LATEST
        </button>
      )}
      {/* Last, so the whole outgoing session recedes behind it, transcript
          and rail alike. Only .swapline sits above. */}
      <div aria-hidden className="swapscrim" />
    </div>
  );

  // The session's own header: a nameplate. The title has a line to itself and
  // the row's whole width; project, branch and the running app are its caption
  // underneath. Each of those opens its own menu (the title and the branch the
  // session's, the project name the project's), so the row carries no links of
  // its own. The ledger names its numbers, and the only border left is the way
  // back to CHAT from HIST or NEXT: a hairline separates meta, a border marks an
  // action.
  // data-ctx-* is what right-click reads; a click re-fires it as a contextmenu
  // anchored under the element, so none of these menus is right-click-only.
  const openMenu = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.dispatchEvent(new MouseEvent("contextmenu",
      { bubbles: true, clientX: r.left, clientY: r.bottom }));
  };
  const nameplate = (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 3, flex: "0 1 auto", minWidth: 0 }}>
        <button
          title={sessionId ? "session — rename, pin, move to a worktree…" : undefined}
          data-ctx-type={sessionId ? "session" : undefined}
          data-ctx-id={sessionId ?? undefined}
          data-ctx-label={selected?.title || undefined}
          disabled={!sessionId}
          onClick={openMenu}
          onMouseEnter={() => setTitleHov(true)} onMouseLeave={() => setTitleHov(false)}
          style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0, maxWidth: "100%", padding: 0, border: 0, appearance: "none", background: "transparent", fontFamily: "inherit", textAlign: "left", cursor: sessionId ? "pointer" : "default" }}>
          <span style={{ fontSize: "var(--t13)", lineHeight: "16px", letterSpacing: ".3px", color: "var(--txb)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {selected?.title || "new session"}
          </span>
          {sessionId && <span aria-hidden style={{ flex: "none", fontSize: "var(--t9)", color: titleHov ? "var(--txb)" : "var(--txl)" }}>▾</span>}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 9, height: 12, minWidth: 0, overflow: "hidden" }}>
          <button
            title={sessionProject ? "project — analyze, design system, new session here" : undefined}
            data-ctx-type={sessionProject ? "project" : undefined}
            data-ctx-id={sessionProject ?? undefined}
            data-ctx-label={projectLabel ?? undefined}
            disabled={!sessionProject}
            onClick={openMenu}
            onMouseEnter={() => setProjHov(true)} onMouseLeave={() => setProjHov(false)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none", fontFamily: "var(--mono)", fontSize: "var(--t9)", color: projHov ? "var(--txb)" : "var(--txm)", border: 0, padding: 0, appearance: "none", background: "transparent", cursor: sessionProject ? "pointer" : "default" }}>
            {/* The per-project tint dot is the only colour identifying the project now. */}
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: tint.color, flex: "none" }} />
            {projectLabel || "—"}
          </button>
          {branch && (
            <>
              <span style={hairline(9)} />
              {/* The session menu again: "move to a new worktree" lives there,
                  and the branch you're on is where you notice you want it. */}
              <button
                title={sessionId ? "session branch — session actions" : "session branch"}
                data-ctx-type={sessionId ? "session" : undefined}
                data-ctx-id={sessionId ?? undefined}
                data-ctx-label={branch}
                disabled={!sessionId}
                onClick={openMenu}
                onMouseEnter={() => setBrHov(true)} onMouseLeave={() => setBrHov(false)}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", fontFamily: "var(--mono)", fontSize: "var(--t9)", color: brHov ? "var(--purple-h)" : "var(--purple-d)", border: 0, padding: 0, appearance: "none", background: "transparent", cursor: sessionId ? "pointer" : "default" }}>
                <span style={{ color: "var(--purple-g)" }}>⎇</span>{branch}
              </button>
            </>
          )}
          {run && (
            <>
              <span style={hairline(9)} />
              <RunChip run={run} onClick={onOpenRun} />
            </>
          )}
        </div>
      </div>
  );
  const readouts = (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
        {/* The row's one link. The project modal — files, git, worktrees, the
            terminal — is worth a click of its own; its neighbours (design
            system, tasks, issues) stay in the menu on the project's name. */}
        {isChat && onOpenProject && (
          <>
            <button onClick={onOpenProject} title="project — files, git, worktrees, terminal"
              onMouseEnter={() => setProjBtnHov(true)} onMouseLeave={() => setProjBtnHov(false)}
              style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: 0, flex: "none", border: 0, background: "transparent", color: projBtnHov ? "var(--txb)" : "var(--txd)" }}>
              ⊞ PROJECT
            </button>
            <span style={hairline(11)} />
          </>
        )}
        {/* No turns, no checkpoints, and no hairline left hanging in front of TIME. */}
        {isChat && turns.length > 0 && (
          <>
            <Checkpoints turns={turns} scrollRef={scrollRef} project={sessionProject} branch={branch} nav={navRef} onJump={onJumpMark} />
            <span style={hairline(11)} />
          </>
        )}
        {isChat && (
          <SpendPanel sessionId={sessionId ?? selected?.id ?? null} running={!!activeId} />
        )}
        <ViewTabs view={view} onView={onView} />
        {chrome && (
          <>
            <span style={hairline(11)} />
            {chrome}
          </>
        )}
      </div>
  );
  const header = compact ? (
    <div style={{ display: "flex", alignItems: "center", padding: "0 16px", height: 34, flex: "none", minWidth: 0 }}>
      {readouts}
    </div>
  ) : (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 12px", height: 40, flex: "none", minWidth: 0 }}>
      {nameplate}
      <span style={{ flex: 1, minWidth: 12 }} />
      {readouts}
    </div>
  );

  // The header is an island. In CHAT it floats over the transcript, which runs
  // to the column's top edge and scrolls under it, and the LAST line folds into
  // it as a second row instead of being a band of its own. HIST and NEXT keep
  // the same island in the flow, so their lists never slide under it. `.panel`
  // makes it the theme's own card: brackets and hard corners in the HUD themes,
  // a soft radius in the reading ones. The blur sits on a layer of its own so
  // it isn't the containing block for anything fixed inside the row.
  const island = (
    // `isle` / `isle-glass`: VOID re-inks both (index.css) — the border and the
    // glass are inline here, and a theme can only outrank an inline rule by name.
    // COMPACT: the same island shrink-wrapped to its readouts and parked on the
    // right as a pill — a thing that holds numbers, not a bar pretending to be
    // the column's top edge. No corner brackets: they belong to a rectangle.
    <div className={compact ? "isle isle-pill" : "panel isle"} style={{
      ...(compact
        ? isChat
          ? { position: "absolute", top: ISLE_TOP, right: `calc(${chatPad} + ${ISLE_X}px)`, maxWidth: `calc(100% - 2 * (${chatPad} + ${ISLE_X}px))` }
          : { position: "relative", alignSelf: "flex-end", margin: `${ISLE_TOP}px ${ISLE_X}px 0` }
        : isChat
          ? { position: "absolute", top: ISLE_TOP, left: `calc(${chatPad} + ${ISLE_X}px)`, right: `calc(${chatPad} + ${ISLE_X}px)` }
          : { margin: `${ISLE_TOP}px ${ISLE_X}px 0` }),
      zIndex: 12, flex: "none",
      borderRadius: compact ? 999 : undefined,
      border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
      boxShadow: "0 10px 28px var(--shadow-pop)",
    }}>
      <div aria-hidden className="isle-glass" style={{ position: "absolute", inset: 0, borderRadius: "inherit", background: `color-mix(in srgb, var(--panel) ${compact ? 97 : 88}%, transparent)`, backdropFilter: "blur(10px) saturate(1.15)" }} />
      <div style={{ position: "relative" }}>
        {header}
        {isChat && !empty && !compact && (
          // Stays mounted and folds: mounting it on the crossing popped a row
          // into place mid-scroll. A fixed height is what lets the observer's
          // edge and the anchors' scroll-margin agree on where the island ends.
          <div aria-hidden={!showPeek || undefined} style={{ height: showPeek ? PEEK_H : 0, opacity: showPeek ? 1 : 0, overflow: "hidden", transition: "height .26s cubic-bezier(.2,.8,.2,1), opacity .2s ease" }}>
            <div style={{ height: PEEK_H, boxSizing: "border-box", padding: "0 12px", borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", alignItems: "center", gap: 10 }}>
              {held.current && (
                // Keyed on the text so moving to another turn crossfades the
                // line instead of swapping it under you.
                <div key={held.current.text} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, animation: "tickfade .22s ease both" }}>
                  <span style={{ width: 2, height: 12, background: "var(--purple-g)", flex: "none" }} />
                  <span style={{ fontSize: "var(--t9)", letterSpacing: 1.4, color: "var(--purple-g)", flex: "none" }}>LAST</span>
                  {/* Dimmer than the transcript it points at — it's a pointer, not the text. */}
                  <span style={{ color: "var(--txd)", fontSize: "var(--t11)", minWidth: 0, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{held.current.text}</span>
                  <button
                    type="button" onClick={onJumpBottom} title="jump to latest" tabIndex={showPeek ? 0 : -1}
                    onMouseEnter={() => setCntHov(true)} onMouseLeave={() => setCntHov(false)}
                    style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", padding: 0, fontFamily: "var(--mono)", fontSize: "var(--t95)", color: cntHov ? "var(--txb)" : "var(--txl)", flex: "none", fontVariantNumeric: "tabular-nums" }}
                  >↓ {held.current.label}</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      data-ctx-type="terminal"
      // The centre column carries no frame of its own: the sidebars' hairlines
      // already say where it starts, and a border here would draw them twice.
      // Pinned to the centre track: a row with no column is placed before the
      // auto-placed side columns, and would take the first track from SESSIONS.
      data-bg={hud?.chatBg ?? "none"}
      data-layout={compact ? "compact" : "default"}
      style={{ position: "relative", gridColumn: 2, gridRow, backgroundColor: "color-mix(in srgb, var(--panel2) 60%, transparent)", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, overflow: "hidden", paddingInline: chatPad, animation: "enterZoom .65s cubic-bezier(.2,.8,.2,1) both .12s" }}
    >
      {island}

      {view === "history" ? (
        <div style={{ minHeight: 0, flex: 1, overflowY: "auto" }}>
          <HistoryView onOpen={onOpenFromHistory} />
        </div>
      ) : view === "next" ? (
        <div style={{ minHeight: 0, flex: 1, overflowY: "auto" }}>
          <NextView onStart={onStartNext} />
        </div>
      ) : (
        <>
          {body}
          <ChatChromeContext.Provider value={{ compact, lead: compact ? nameplate : null }}>
            {composer}
          </ChatChromeContext.Provider>
        </>
      )}
    </div>
  );
}
