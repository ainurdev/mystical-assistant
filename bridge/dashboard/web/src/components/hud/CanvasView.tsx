import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { FlowShape } from "../../api";
import { fitWidth, zoomAt, type Viewport } from "../../lib/board";

/** The transcript as a board instead of a scroller.
 *
 *  The same turns, the same cards — laid out at a fixed column width on an
 *  infinite surface you drag and zoom, with a second column beside them for
 *  things that want to stay in view while the transcript runs on. Zooming out is
 *  the point: a long session is unreadable at 100% and legible as *shape* at
 *  40%, which is how you find the turn you half-remember.
 *
 *  Why the chat column is a fixed 760px rather than fluid: a card that reflows
 *  as you zoom has no shape to recognise. The board is the thing that scales;
 *  the cards keep their proportions the whole way down.
 *
 *  The world layer is one transformed div, so the browser composites the pan on
 *  the GPU and nothing re-lays-out per frame. Everything with `data-ui` is
 *  outside it — chrome stays at 1:1 no matter how far the board is zoomed. */

/** World layer inset. The board hangs below the floating strip and clear of the
 *  left edge, so an un-panned canvas opens with its first card already framed. */
const OX = 48;
const OY = 76;
/** Column geometry, shared with the fit presets: CHAT frames the transcript
 *  alone, CANVAS frames the transcript plus the pinned rail. */
const CHAT_W = 760;
const RAIL_X = 812;
const RAIL_W = 340;
const BOARD_W = RAIL_X + RAIL_W;

/** Elements a drag must not steal: cards own their text selection, chrome owns
 *  its clicks. Everything else is empty board, and empty board pans. */
const NO_PAN = "[data-card],[data-ui],button,input,textarea,select,a,[contenteditable]";

export function FlowMapCard({ flow, stage }: { flow: FlowShape; stage: string | null }) {
  const at = flow.stages.findIndex((s) => s.id === stage);
  return (
    <div
      data-card
      style={{
        border: "1px solid color-mix(in srgb, var(--acc) 26%, transparent)",
        background: "color-mix(in srgb, var(--panel2) 92%, transparent)",
        boxShadow: "0 10px 30px var(--shadow-pop)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--ac-12)", fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txd)" }}>
        <svg viewBox="0 0 18 18" width="11" height="11" fill="none" style={{ flex: "none" }}>
          <rect x="4.5" y="4.5" width="9" height="9" transform="rotate(45 9 9)" stroke="var(--acc)" strokeWidth="1.6" />
        </svg>
        <span style={{ color: "var(--txh)" }}>FLOW MAP</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--txf)" }}>{flow.label.toUpperCase()}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, padding: "11px 12px" }}>
        {flow.stages.map((s, i) => {
          const here = i === at;
          const past = at >= 0 && i < at;
          return (
            <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {i > 0 && <span style={{ color: "var(--txl)", fontSize: "var(--t9)" }}>›</span>}
              <span
                title={s.gate ? `${s.label} — gated` : s.label}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  border: `1px solid ${here ? "color-mix(in srgb, var(--acc) 50%, transparent)" : "var(--ac-12)"}`,
                  background: here ? "var(--ac-08)" : "transparent",
                  color: here ? "var(--txb)" : past ? "var(--txf)" : "var(--txd)",
                  fontSize: "var(--t9)", letterSpacing: ".5px", padding: "3px 7px",
                }}
              >
                {here && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ok)", flex: "none" }} />}
                {s.label.toUpperCase()}
                {s.gate && <span style={{ color: "var(--warn)" }}>⛨</span>}
              </span>
            </span>
          );
        })}
      </div>
      <div style={{ padding: "7px 12px", borderTop: "1px solid var(--ac-12)", fontSize: "var(--t9)", color: "var(--txl)" }}>
        {at >= 0 ? `stage ${at + 1} of ${flow.stages.length}` : `${flow.stages.length} stages · not started`}
      </div>
    </div>
  );
}

export function CanvasView({
  header, rail, composer, children,
}: {
  /** The floating strip's contents — pills, title, the CHAT/CANVAS switch. */
  header: ReactNode;
  /** The pinned column beside the transcript. */
  rail: ReactNode;
  /** Floated over the board's bottom edge, so the board runs full-bleed. */
  composer: ReactNode;
  /** The transcript itself, rendered into the chat column. */
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<Viewport>({ tx: 0, ty: 0, scale: 1 });
  const [snap, setSnap] = useState(false);
  const [panning, setPanning] = useState(false);
  const [mode, setMode] = useState<"chat" | "board">("chat");

  const fit = (m: "chat" | "board", animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    setMode(m);
    setSnap(animate);
    setV(fitWidth(el.clientWidth, m === "chat" ? CHAT_W : BOARD_W, OX));
  };

  // Frame the transcript on arrival. Layout effect, so the board is never
  // painted at the wrong scale first.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wide = el.clientWidth > 1100;
    setMode(wide ? "board" : "chat");
    setV(fitWidth(el.clientWidth, wide ? BOARD_W : CHAT_W, OX));
  }, []);

  // Non-passive, because a plain wheel pans and a ctrl/pinch wheel zooms — both
  // have to beat the browser's own scroll and page-zoom. React's onWheel is
  // passive and cannot preventDefault.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setSnap(false);
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        setV((p) => zoomAt(p, e.clientX - r.left - OX, e.clientY - r.top - OY, e.deltaY < 0 ? 1.09 : 1 / 1.09));
      } else {
        setV((p) => ({ ...p, tx: p.tx - e.deltaX, ty: p.ty - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(NO_PAN)) return;
    const { clientX: sx, clientY: sy } = e;
    const from = v;
    // Suppressed for the drag only: without it the pointer sweeps a selection
    // across every card it crosses on the way.
    document.body.style.userSelect = "none";
    setPanning(true);
    setSnap(false);
    const move = (ev: PointerEvent) =>
      setV({ ...from, tx: from.tx + ev.clientX - sx, ty: from.ty + ev.clientY - sy });
    const up = () => {
      document.body.style.userSelect = "";
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function zoomCentre(factor: number) {
    const el = ref.current;
    if (!el) return;
    setSnap(false);
    setV((p) => zoomAt(p, el.clientWidth / 2 - OX, el.clientHeight / 2 - OY, factor));
  }

  const zoomBtn = {
    appearance: "none" as const, cursor: "pointer", border: 0, background: "transparent",
    color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t12)", width: 24, height: 22,
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      style={{
        position: "relative", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden",
        cursor: panning ? "grabbing" : "default",
        background: "var(--panel3)",
        backgroundImage: "radial-gradient(circle,var(--ac-12) 1px,transparent 1.3px)",
        backgroundSize: `${24 * v.scale}px ${24 * v.scale}px`,
        backgroundPosition: `${OX + v.tx}px ${OY + v.ty}px`,
      }}
    >
      <div
        style={{
          position: "absolute", left: OX, top: OY, transformOrigin: "0 0",
          transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`,
          transition: snap ? "transform .4s cubic-bezier(.22,1,.32,1)" : "none",
          willChange: "transform",
        }}
      >
        {/* ponytail: the transcript full-mounts here — no virtualizer, because a
            scaled transformed layer has no scroll container to measure against.
            RunStream's own content-visibility carries it, the same way ctrl-F's
            full mount does in the scroller. If a 3000-turn session drags, the
            fix is windowing on the world rect, not on a scrollTop. */}
        <div data-card style={{ position: "absolute", left: 0, top: 0, width: CHAT_W }}>
          {children}
        </div>
        <div style={{ position: "absolute", left: RAIL_X, top: 0, width: RAIL_W, display: "flex", flexDirection: "column", gap: 12 }}>
          {rail}
          <div
            data-card
            style={{
              border: "1px dashed var(--ac-16)", padding: 13,
              fontSize: "var(--t10)", lineHeight: 1.7, color: "var(--txl)", letterSpacing: ".5px",
            }}
          >
            drag the board to pan · ⌘ or ctrl + scroll to zoom · CHAT and CANVAS
            re-frame the view
          </div>
        </div>
      </div>

      <div
        data-ui
        style={{
          position: "absolute", top: 0, left: 0, right: 0, zIndex: 5,
          display: "flex", alignItems: "center", gap: 9, padding: "8px 14px",
          background: "color-mix(in srgb, var(--panel2) 82%, transparent)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid var(--ac-12)",
        }}
      >
        {header}
      </div>

      <div
        data-ui
        style={{
          position: "absolute", right: 14, top: 54, zIndex: 5,
          display: "flex", alignItems: "center", gap: 2, padding: 3,
          border: "1px solid var(--ac-16)",
          background: "color-mix(in srgb, var(--panel2) 92%, transparent)",
          backdropFilter: "blur(10px)",
          fontFamily: "'JetBrains Mono',monospace",
        }}
      >
        <button title="zoom out" onClick={() => zoomCentre(1 / 1.2)} style={zoomBtn}>−</button>
        <span style={{ width: 40, textAlign: "center", fontSize: "var(--t9)", color: "var(--txh)" }}>
          {Math.round(v.scale * 100)}%
        </span>
        <button title="zoom in" onClick={() => zoomCentre(1.2)} style={zoomBtn}>+</button>
        <span style={{ width: 1, height: 13, background: "var(--ac-16)", margin: "0 3px" }} />
        <button
          title="re-frame the board" onClick={() => fit(mode, true)}
          style={{ ...zoomBtn, width: "auto", padding: "0 8px", fontSize: "var(--t9)", letterSpacing: 1.5 }}
        >
          FIT
        </button>
        <button
          title={mode === "chat" ? "frame the transcript and its rail" : "frame the transcript alone"}
          onClick={() => fit(mode === "chat" ? "board" : "chat", true)}
          style={{ ...zoomBtn, width: "auto", padding: "0 8px", fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--acc)" }}
        >
          {mode === "chat" ? "BOARD" : "COLUMN"}
        </button>
      </div>

      <div
        data-ui
        style={{
          position: "absolute", left: "50%", bottom: 14, zIndex: 6,
          transform: "translateX(-50%)", width: "min(820px, calc(100% - 40px))",
          border: "1px solid var(--ac-22)",
          background: "color-mix(in srgb, var(--panel2) 94%, transparent)",
          backdropFilter: "blur(14px)",
          boxShadow: "0 16px 48px var(--shadow-modal)",
          padding: "8px 10px",
        }}
      >
        {composer}
      </div>
    </div>
  );
}
