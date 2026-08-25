import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { FlowStageShape } from "../../api";
import type { PanelTab } from "../RightPanel";
import { engagement } from "../../lib/flows";
import { ORIGIN_X, ORIGIN_Y, fitBoard, zoomAt, type Viewport } from "../../lib/viewport";

/* CANVAS — the transcript as a board rather than a page.
 *
 * The conversation keeps its own column and its own scroller; the canvas is the
 * space *around* it, where a session's standing context (the flow map, and
 * whatever gets pinned next) sits beside the talking instead of above it in a
 * panel you have to go and open. Drag the empty grid to pan, ⌘/ctrl-scroll to
 * zoom, and the two fit presets frame either the conversation alone or the
 * whole board.
 *
 * Why the chat column scrolls itself instead of laying every turn out flat in
 * world space, which is what the mock drew: flat layout would mean rendering
 * all of a 400-turn session at once, and turn-row virtualisation exists in
 * Transcript precisely because that is not affordable. Handing the column its
 * own scroller keeps the virtualiser, the checkpoint rail, the sticky prompt
 * peek and jump-to-latest working unchanged — the canvas adds a board without
 * rebuilding the thing on it.
 *
 * ponytail: the gutter is a column, not a user-arranged board — pins stack in
 * the order they were added. Give them positions and a store when stacking is
 * the thing that's in the way.
 */

const CHAT_W = 760;
const PIN_W = 340;
/** How tall a pinned sidebar panel may stand. Enough rows to be worth pinning,
 *  short enough that two pins still fit a laptop screen without panning. */
const PIN_H = 320;
const PIN_X = 812; // the chat column plus a 52px gutter
const BOARD_W = PIN_X + PIN_W;

/** Breathing room between the conversation column and the floating footer. */
const FOOTER_GAP = 20;

const SNAP = "transform .4s cubic-bezier(.22,1,.32,1)";

export function Canvas({
  chat,
  pins,
  footer,
  header,
  focus,
  onFocus,
}: {
  /** The conversation column — owns its own scroller (see the note above). */
  chat: ReactNode;
  /** Cards standing beside the conversation. */
  pins?: ReactNode;
  /** The composer, floated over the bottom of the board. */
  footer?: ReactNode;
  /** The session header, floated over the top of the board. */
  header?: ReactNode;
  /** Focus mode — the board alone, both sidebars folded away. App owns the
   *  state; the board owns the switch, because this is where you want it. */
  focus?: boolean;
  onFocus?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<Viewport>({ tx: 0, ty: 0, scale: 1 });
  const [snap, setSnap] = useState(false);
  const [panning, setPanning] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The footer floats, so it is out of flow and cannot push the column short.
  // Measured rather than guessed at: the composer grows with queued prompts, a
  // stage hint, an attachment strip — every one of which would otherwise bury
  // the newest turn under the thing you reply with.
  const [footH, setFootH] = useState(0);

  const fit = useCallback((boardW: number) => {
    const w = ref.current?.clientWidth ?? 0;
    if (!w) return;
    setSnap(true);
    setView(fitBoard(w, boardW));
  }, []);

  // Track the canvas box: the fit presets need its width, and the chat column
  // needs its height (it is a scroller, so it cannot size to its content).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const foot = footRef.current;
    const fro = foot && new ResizeObserver(() => setFootH(foot.offsetHeight));
    if (foot && fro) { fro.observe(foot); setFootH(foot.offsetHeight); }
    return () => { ro.disconnect(); fro?.disconnect(); };
  }, []);

  // Open framed. A narrow canvas frames the conversation alone — fitting the
  // whole board there would shrink the transcript past reading size to make
  // room for cards that are only context.
  const framed = useRef(false);
  useLayoutEffect(() => {
    if (framed.current || !size.w) return;
    framed.current = true;
    setView(fitBoard(size.w, size.w > 1100 ? BOARD_W : CHAT_W));
  }, [size.w]);

  // Native listener, because zooming has to preventDefault and React's onWheel
  // is passive — the browser would page-zoom out from under the board.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        setSnap(false);
        setView((v) => zoomAt(v, e.clientX - r.left - ORIGIN_X, e.clientY - r.top - ORIGIN_Y,
                              e.deltaY < 0 ? 1.09 : 1 / 1.09));
        return;
      }
      // Over the conversation, a plain wheel is still a scroll. Panning the
      // board out from under someone reading is the one thing the canvas must
      // not do to the view it exists to hold.
      if ((e.target as Element | null)?.closest?.("[data-canvas-scroll]")) return;
      e.preventDefault();
      setSnap(false);
      setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag the grid to pan. Cards and chrome are not handles: a drag that starts
  // on a card is someone selecting text in it.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-card],[data-ui],button,input,textarea,a")) return;
    const sx = e.clientX, sy = e.clientY;
    const from = view;
    document.body.style.userSelect = "none";
    setSnap(false);
    setPanning(true);
    const move = (ev: PointerEvent) =>
      setView({ ...from, tx: from.tx + ev.clientX - sx, ty: from.ty + ev.clientY - sy });
    const up = () => {
      document.body.style.userSelect = "";
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const zoomBy = (f: number) => {
    const el = ref.current;
    if (!el) return;
    setSnap(true);
    setView((v) => zoomAt(v, el.clientWidth / 2 - ORIGIN_X, el.clientHeight / 2 - ORIGIN_Y, f));
  };

  const chatH = Math.max(320, size.h - ORIGIN_Y - footH - FOOTER_GAP * 2);

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      style={{
        flex: 1, position: "relative", overflow: "hidden", minHeight: 0,
        cursor: panning ? "grabbing" : "default",
        backgroundImage:
          "radial-gradient(circle, color-mix(in srgb, var(--acc) 15%, transparent) 1px, transparent 1.3px)",
        backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
        backgroundPosition: `${ORIGIN_X + view.tx}px ${ORIGIN_Y + view.ty}px`,
      }}
    >
      <div
        style={{
          position: "absolute", left: ORIGIN_X, top: ORIGIN_Y,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          transformOrigin: "0 0",
          transition: snap ? SNAP : "none",
          willChange: "transform",
        }}
      >
        <div
          data-card
          style={{
            position: "absolute", left: 0, top: 0, width: CHAT_W, height: chatH,
            display: "flex", flexDirection: "column", minHeight: 0,
            border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
            background: "color-mix(in srgb, var(--panel2) 92%, transparent)",
            boxShadow: "0 10px 30px var(--shadow-pop)",
            overflow: "hidden",
          }}
        >
          {chat}
        </div>
        {/* Dropped below the conversation's top edge so the zoom HUD, which
            floats at the same corner, does not sit on the first pinned card's
            title. Chrome over content is fine; chrome over a label is not. */}
        {pins && (
          <div style={{ position: "absolute", left: PIN_X, top: 44, width: PIN_W, display: "flex", flexDirection: "column", gap: 14 }}>
            {pins}
          </div>
        )}
      </div>

      {/* Glass, not a panel header: the grid runs edge to edge underneath it,
          which is what makes the board read as a surface the conversation sits
          on rather than a third pane stacked below a title bar. */}
      {header && (
        <div
          data-ui
          style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 7,
            background: "color-mix(in srgb, var(--panel2) 88%, transparent)",
            backdropFilter: "blur(10px)",
            borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
          }}
        >
          {header}
        </div>
      )}

      {/* The composer floats over the board rather than sitting under it: on a
          canvas the bottom edge is more board, not a footer. */}
      {footer && (
        <div
          ref={footRef}
          data-ui
          style={{
            position: "absolute", left: "50%", bottom: FOOTER_GAP, zIndex: 8,
            transform: "translateX(-50%)", width: `min(820px, calc(100% - ${FOOTER_GAP * 3}px))`,
            border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
            background: "color-mix(in srgb, var(--panel2) 94%, transparent)",
            backdropFilter: "blur(14px)",
            boxShadow: "0 16px 48px var(--shadow-pop)",
          }}
        >
          {footer}
        </div>
      )}

      <div
        data-ui
        style={{
          position: "absolute", right: 14, top: 56, zIndex: 8,
          display: "flex", alignItems: "center", gap: 2, padding: 3,
          border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
          background: "color-mix(in srgb, var(--panel2) 92%, transparent)",
          backdropFilter: "blur(10px)",
          fontFamily: "'JetBrains Mono',monospace",
        }}
      >
        <ZoomBtn title="zoom out" onClick={() => zoomBy(1 / 1.2)}>−</ZoomBtn>
        <span style={{ width: 44, textAlign: "center", fontSize: "var(--t105)", color: "var(--tx)", fontVariantNumeric: "tabular-nums" }}>
          {Math.round(view.scale * 100)}%
        </span>
        <ZoomBtn title="zoom in" onClick={() => zoomBy(1.2)}>+</ZoomBtn>
        <span aria-hidden style={{ width: 1, height: 14, background: "color-mix(in srgb, var(--acc) 22%, transparent)", margin: "0 3px" }} />
        <ZoomBtn title="frame the conversation" onClick={() => fit(CHAT_W)} wide>CHAT</ZoomBtn>
        <ZoomBtn title="frame the whole board" onClick={() => fit(BOARD_W)} wide>BOARD</ZoomBtn>
        {onFocus && (
          <>
            <span aria-hidden style={{ width: 1, height: 14, background: "color-mix(in srgb, var(--acc) 22%, transparent)", margin: "0 3px" }} />
            <ZoomBtn title={focus ? "bring the sidebars back" : "focus — the board alone"} onClick={onFocus} wide on={focus}>
              {focus ? "◱ EXIT" : "◱ FOCUS"}
            </ZoomBtn>
          </>
        )}
      </div>
    </div>
  );
}

function ZoomBtn({ children, onClick, title, wide, on }: { children: ReactNode; onClick: () => void; title: string; wide?: boolean; on?: boolean }) {
  return (
    <button
      type="button" onClick={onClick} title={title} aria-pressed={on}
      className="hover:bg-[var(--ac-08)] hover:text-[var(--txb)]"
      style={{
        appearance: "none", cursor: "pointer", border: 0,
        background: on ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent",
        color: on ? "var(--txb)" : "var(--txd)", fontFamily: "inherit", height: 26,
        width: wide ? undefined : 26, padding: wide ? "0 9px" : 0,
        fontSize: wide ? "var(--t10)" : "var(--t13)", letterSpacing: wide ? 1.5 : 0,
      }}
    >{children}</button>
  );
}

/** A pinned card's frame — bracketed like every other HUD panel, with a title
 *  strip that names what is standing there and why. */
export function PinCard({ title, note, right, children }: {
  title: string; note?: string; right?: ReactNode; children: ReactNode;
}) {
  return (
    <div
      data-card
      style={{
        border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
        background: "color-mix(in srgb, var(--panel2) 92%, transparent)",
        boxShadow: "0 10px 30px var(--shadow-pop)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", fontSize: "var(--t95)", letterSpacing: 1.8, color: "var(--txl)" }}>
        <span style={{ color: "var(--acc)" }}>◇</span>
        <span style={{ color: "var(--txh)" }}>{title}</span>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {children}
      {note && (
        <div style={{ padding: "7px 12px", borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", fontSize: "var(--t9)", color: "var(--txf)" }}>
          {note}
        </div>
      )}
    </div>
  );
}

/** The session's flow drawn as a map rather than a rail: three across, so a
 *  six-stage flow reads as a shape you can take in at a glance instead of a
 *  line that runs off the card. The stage you are on is lit; gates carry a ◆,
 *  the same mark they wear on the rail. */
export function FlowMap({ stages, current, turnCount }: {
  stages: FlowStageShape[]; current: string | null; turnCount: number;
}) {
  const at = stages.findIndex((s) => s.id === current);
  const rows: FlowStageShape[][] = [];
  for (let i = 0; i < stages.length; i += 3) rows.push(stages.slice(i, i + 3));
  // What the stage you are standing on wants of you, on the map rather than
  // only on the hint line — the map is what stays pinned when the composer has
  // scrolled away, and "how much is this asking" is the reason to glance at it.
  const eng = engagement(at >= 0 ? stages[at].input : null);
  return (
    <PinCard
      title="FLOW MAP"
      note={`auto-synced from turn ${turnCount}`}
      right={
        <span
          title={`engagement L${eng.level} — ${eng.verb.toLowerCase()}`}
          style={{ color: eng.level > 0 ? "var(--purple)" : "var(--txf)" }}
        >
          L{eng.level} · {eng.verb}
        </span>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 12px" }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {row.map((s, ci) => {
              const i = ri * 3 + ci;
              const on = i === at;
              const done = at >= 0 && i < at;
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                  <span
                    title={s.gate ? `${s.label} — gate` : s.label}
                    style={{
                      flex: 1, minWidth: 0, textAlign: "center", padding: "6px 4px",
                      fontSize: "var(--t9)", letterSpacing: 0.5,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      border: `1px solid color-mix(in srgb, var(--acc) ${on ? 55 : 18}%, transparent)`,
                      background: on ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "transparent",
                      color: on ? "var(--txb)" : done ? "var(--txd)" : "var(--txf)",
                    }}
                  >
                    {s.gate && <span style={{ color: "var(--purple)" }}>◆ </span>}
                    {s.label.toUpperCase()}
                  </span>
                  {ci < row.length - 1 && <span aria-hidden style={{ flex: "none", color: "var(--txf)", fontSize: "var(--t9)" }}>→</span>}
                </div>
              );
            })}
            {/* Pad a short last row so its boxes keep the width of the rows above. */}
            {row.length < 3 && <span aria-hidden style={{ flex: 3 - row.length }} />}
          </div>
        ))}
      </div>
    </PinCard>
  );
}

/** A right-sidebar panel standing on the board. The panel draws its own frame
 *  and its own title, so the pin adds nothing but a height and a shadow — a
 *  second border around a bordered panel reads as a bug, not as a card.
 *
 *  ponytail: a panel pinned here and open in the sidebar polls twice. Both
 *  copies are cheap reads; share a cache if the pins grow teeth. */
export function PanelPin({ tab }: { tab: PanelTab }) {
  return (
    <div
      data-card
      className={tab.ownScroll ? "" : "mscroll"}
      style={{
        display: "flex", flexDirection: "column", minHeight: 0,
        // A panel that owns its scroller needs a height to scroll inside; the
        // rest grow to their content and the card scrolls at the cap.
        height: tab.ownScroll ? PIN_H : undefined,
        maxHeight: PIN_H,
        overflowY: tab.ownScroll ? "hidden" : "auto",
        boxShadow: "0 10px 30px var(--shadow-pop)",
      }}
    >
      {tab.render()}
    </div>
  );
}

/** Which sidebar panels stand on the board. A lit chip unpins, which is why no
 *  pinned card carries an ✕ of its own: those panels draw their own headers and
 *  already own their top-right corner. Also carries what the board does — one
 *  card in the gutter saying both beats two saying one each. */
export function PinPicker({ tabs, pinned, onPin }: {
  tabs: PanelTab[]; pinned: string[]; onPin: (id: string) => void;
}) {
  return (
    <div
      data-card
      style={{
        border: "1px dashed color-mix(in srgb, var(--acc) 20%, transparent)",
        padding: 14, fontSize: "var(--t10)", lineHeight: 1.8, color: "var(--txf)",
      }}
    >
      <div style={{ letterSpacing: 1.8, color: "var(--txl)", marginBottom: 8 }}>PIN A PANEL</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {tabs.map((t) => {
          const on = pinned.includes(t.id);
          // The sidebar's own badge count rides the label ("Changed files (3)");
          // on a chip it is noise, and the pinned panel states it anyway.
          const label = t.label.replace(/\s*\(\d+\)$/, "").toUpperCase();
          return (
            <button
              key={t.id} type="button" aria-pressed={on}
              onClick={() => onPin(t.id)}
              title={on ? `unpin ${label}` : `pin ${label} beside the conversation`}
              className="hover:bg-[var(--ac-08)] hover:text-[var(--txb)]"
              style={{
                display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
                appearance: "none", fontFamily: "inherit", padding: "3px 7px",
                fontSize: "var(--t9)", letterSpacing: 1, lineHeight: 1.4,
                border: `1px solid color-mix(in srgb, var(--acc) ${on ? 45 : 16}%, transparent)`,
                background: on ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "transparent",
                color: on ? "var(--txb)" : "var(--txd)",
              }}
            >
              {t.icon}{label}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        drag the grid to pan · ⌘ scroll to zoom<br />
        CHAT / BOARD frame the view
      </div>
    </div>
  );
}
