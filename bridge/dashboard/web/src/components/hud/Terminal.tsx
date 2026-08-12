import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AnswerSelection, EnrichedSession, NextItem, SessionBrief } from "../../api";
import type { Turn } from "../../chat";
import { surfaceFor, projectTint } from "../../lib/surfaces";
import type { HudSettings } from "../../lib/theme";
import { Transcript } from "../Transcript";
import { HistoryView } from "../HistoryView";
import { NextView } from "../NextView";
import { ViewTabs, type View } from "./ViewTabs";
import { Checkpoints, ScrollRail } from "./Checkpoints";

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
  return clean.split("/").pop() || clean;
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

/** The empty-session intro: the mystical assistant face + a rotating quote. */
function FreshState({ project }: { project: string | null }) {
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
    <div style={{ height: "100%", minHeight: 330, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, textAlign: "center", animation: "mfadeup .5s ease both" }}>
      <div style={{ position: "relative", width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", opacity: 0.5 }}>
          <circle cx="50" cy="50" r="46" fill="none" stroke="var(--acc)" strokeWidth="1" strokeDasharray="5 9" style={{ transformOrigin: "50px 50px", animation: "introspin 11s linear infinite" }} />
          <circle cx="50" cy="50" r="38" fill="none" stroke="color-mix(in srgb, var(--purple) 40%, transparent)" strokeWidth="1" strokeDasharray="3 13" style={{ transformOrigin: "50px 50px", animation: "introspinr 16s linear infinite" }} />
        </svg>
        <div style={{ position: "relative", width: 92, height: 92, borderRadius: "50%", border: "1.5px solid color-mix(in srgb, var(--acc) 50%, transparent)", background: "radial-gradient(circle at 50% 36%,color-mix(in srgb, var(--acc) 16%, transparent),color-mix(in srgb, var(--panel2) 60%, transparent))", boxShadow: "0 0 28px color-mix(in srgb, var(--acc) 18%, transparent),inset 0 0 22px color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, animation: "bob 4.5s ease-in-out infinite" }}>
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
    </div>
  );
}

/** The "channel tuning" loading state: a held, unstable scanline (the collapsed
 *  channel) that stays until the transcript is ready — then the viewport blooms open.
 *  Replaces a spinner so the channel-change transition spans the whole load. */
function ChannelTuning() {
  return (
    <div style={{ height: "100%", minHeight: 330, position: "relative", overflow: "hidden", animation: "mfadeup .3s ease both" }}>
      <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 2, transform: "translateY(-50%)", background: "var(--acc)", boxShadow: "0 0 20px 2px color-mix(in srgb, var(--acc) 80%, transparent), 0 0 4px var(--acc)", animation: "chanline 1.15s ease-in-out infinite" }} />
      <span style={{ position: "absolute", left: 0, right: 0, top: "calc(50% + 30px)", textAlign: "center", fontSize: "var(--t10)", letterSpacing: 3, background: "linear-gradient(90deg,var(--txl) 0%,var(--txl) 28%,#9fe9dd 50%,var(--txl) 72%,var(--txl) 100%)", backgroundSize: "200% 100%", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", animation: "awaitsweep 2.4s linear infinite" }}>TUNING SIGNAL…</span>
    </div>
  );
}

export function Terminal({
  view, onView, selected, activeProject, branch, turns, activeId, onRespond,
  scrollRef, contentRef, atBottom, onJumpBottom, composer, onOpenFromHistory, onStartNext,
  liveTurns, trailingWorking,
  loading, sessionId, hud, onRunCommand, onQuote, onOpenFile, onAnswer,
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
  loading?: boolean;
  sessionId?: string | null;
  hud?: HudSettings;
  /** Re-run a transcript command in this project's TERMINAL tab. */
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onAnswer?: (text: string) => void;
}) {
  const surf = surfaceFor(selected?.origin);
  const sessionProject = selected?.project ?? activeProject ?? null;
  const tint = projectTint(sessionProject);
  const projectLabel = basename(sessionProject);
  const empty = view === "chat" && turns.length === 0;
  // The most recent prompt, shown beneath the title in the header (clamped to 2 lines).
  const lastPrompt = turns.length ? (turns[turns.length - 1].prompt || "").trim() : "";

  // The sticky "LAST" peek surfaces only once the real prompt has scrolled up out
  // of view — while it's on screen the peek would just duplicate what you can see.
  const lastPromptRef = useRef<HTMLDivElement | null>(null);
  const [peek, setPeek] = useState(false);
  const lastTurnId = turns.length ? turns[turns.length - 1].id : null;
  useEffect(() => {
    setPeek(false);
    const root = scrollRef.current;
    const target = lastPromptRef.current;
    if (view !== "chat" || empty || !root || !target) return;
    const io = new IntersectionObserver(
      ([e]) => {
        const rootTop = e.rootBounds?.top ?? root.getBoundingClientRect().top;
        // Fully out of view AND above the top edge → scrolled past upward.
        setPeek(!e.isIntersecting && e.boundingClientRect.top < rootTop);
      },
      { root, threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [scrollRef, view, empty, lastTurnId]);

  // A session that takes a while to open would otherwise sit as the new header
  // over the old chat with nothing to say it is loading. Mark the swap on the
  // click commit and CSS dims the outgoing transcript and sweeps a hairline —
  // both on a delay, so an open that lands first is still the plain soft cut
  // below. `!loading` is what makes this order-independent with the release
  // effect: on the landing commit this one bails whichever runs first.
  const swapRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (view !== "chat" || !loading || empty) return; // empty: nothing worth holding
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
    if (view !== "chat" || loading) return; // wait until the new transcript has landed
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

  return (
    <div
      className="panel"
      data-ctx-type="terminal"
      style={{ border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, overflow: "hidden", animation: "enterZoom .65s cubic-bezier(.2,.8,.2,1) both .12s" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, padding: "8px 14px", flex: "none", minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0, overflow: "hidden" }}>
            <span title="active project" style={{ display: "flex", alignItems: "center", gap: 5, flex: "none", fontSize: "var(--t9)", letterSpacing: 1, color: tint.color, border: `1px solid ${tint.border}`, padding: "2px 7px" }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: tint.color }} />
              {projectLabel || "—"}
            </span>
            {branch && (
              <span title="session branch" style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", fontSize: "var(--t9)", letterSpacing: ".5px", color: "var(--purple-d)", border: "1px solid color-mix(in srgb, var(--purple) 28%, transparent)", padding: "2px 7px" }}>
                <span style={{ color: "var(--purple)" }}>⎇</span>{branch}
              </span>
            )}
            <span style={{ fontSize: "var(--t11)", letterSpacing: ".5px", color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {selected?.title || "new session"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
          {view === "chat" && (
            <Checkpoints turns={turns} scrollRef={scrollRef} project={sessionProject} branch={branch} />
          )}
          <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: surf.color, border: `1px solid ${surf.color}`, padding: "2px 7px" }}>
            {surf.label.toUpperCase()}
          </span>
          <ViewTabs view={view} onView={onView} />
        </div>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))", transformOrigin: "left", animation: "drawline .8s ease both .15s", flex: "none" }} />

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
          <div ref={swapRef} className="swapwrap" style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <div aria-hidden className="swapline" />
            <div ref={scrollRef} className="mscroll mscroll-bare" style={{ flex: 1, minHeight: 0, padding: "0 18px", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t13)", lineHeight: 1.6, overflowWrap: "break-word" }}>
              <div ref={contentRef} style={{ padding: "16px 0" }}>
                {empty && loading ? (
                  <ChannelTuning />
                ) : empty ? (
                  <FreshState project={sessionProject} />
                ) : (
                  <Transcript turns={turns} activeId={activeId} onRespond={onRespond} liveTurns={liveTurns} trailingWorking={trailingWorking} lastPromptRef={lastPromptRef} hud={hud} onRunCommand={onRunCommand} onQuote={onQuote} onOpenFile={onOpenFile} onAnswer={onAnswer} />
                )}
              </div>
            </div>
            {/* Overlay, not a sticky child of the scroller: in-flow it added ~68px
                to the content the instant it toggled, so the first scroll down from
                the top lurched everything you were reading (and back up on the way
                out). An absolute layer costs the scroll range nothing. */}
            {lastPrompt && !empty && peek && (
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 5, pointerEvents: "none", padding: "9px 18px", background: "linear-gradient(180deg,color-mix(in srgb, var(--panel2) 98%, transparent),color-mix(in srgb, var(--panel2) 86%, transparent))", borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", alignItems: "flex-start", gap: 9 }}>
                <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--purple-g)", flex: "none", marginTop: 3 }}>LAST</span>
                <span style={{ color: "var(--purple)", flex: "none", marginTop: 2, fontSize: "var(--t12)" }}>~ ❯</span>
                <span style={{ color: "var(--txh)", fontSize: "var(--t12)", lineHeight: 1.5, minWidth: 0, flex: 1, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>{lastPrompt}</span>
              </div>
            )}
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
            {/* Last, so the whole outgoing session recedes behind it — transcript,
                LAST peek and rail alike. Only .swapline sits above. */}
            <div aria-hidden className="swapscrim" />
          </div>
          {composer}
        </>
      )}
    </div>
  );
}
