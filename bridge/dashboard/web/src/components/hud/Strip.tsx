import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { type AccountInfo, type Weather } from "../../api";
import { NotificationCenter } from "./Notifications";
import { Almanac } from "./Almanac";
import { zoneTag, zoneTime } from "../../lib/almanac";
import { useClock12 } from "../../lib/surfaces";
import type { WorldClock } from "../../lib/theme";
import { isMacApp, linuxWindow, macWindow } from "../../lib/mac";
import { Minus, PanelLeftClose, Plus, Settings, Square, X, type LucideIcon } from "lucide-react";

/* The shell's chrome, minus the row it used to be.
 *
 * This was a 38px strip across all three columns, and every pixel of it came
 * out of the transcript. Now its ends cap the side columns — Brand over
 * SESSIONS, RightCap over the right panel — and the transcript runs to the top
 * edge, its own header the top line. The middle folded into `Strip`, split in
 * two: an instrument on the left — the clock as the one big readout, the
 * weather and Claude·FM stacked small beside it — and the actions on the
 * right, SHIP and the bell, by the gear. It used to be one right-aligned run
 * of five different treatments; splitting readouts from actions is what reads
 * as order, and the gap between the halves takes up whatever width a theme's
 * font adds or saves, so no theme moves an edge. Every text sits on a trimmed
 * box (`.trim`, index.css) so Consolas and Courier New centre like JetBrains.
 * A click on the clock (or the weather beside it) drops the Almanac under it
 * (Almanac.tsx); the world clocks you pinned sit beside it, and are the first
 * thing to go when the row runs out of width. The clock's own menu and its
 * CLOCK & WEATHER popover are gone: the settings moved to SETTINGS ▸
 * APPEARANCE, and right-click here is the plain dashboard menu.
 *
 * Collapsed, the right column is the rail's 48px, too narrow for the cluster,
 * so App hands it to the chat header instead (Terminal's `chrome`). */

// The chat header's 40px row plus its 1px rule, so a cap's bottom line sits
// level with the header's (border-box: the border is inside the height).
const CAP_H = 41;
const CAP_LINE = "1px solid color-mix(in srgb, var(--acc) 14%, transparent)";
const CAP_IN = "enterDown .55s cubic-bezier(.2,.8,.2,1) both";

export interface StripProps {
  clock: string; // "HH:MM:SS" 24h, from telemetry
  weather: Weather;
  accounts: AccountInfo[]; // every login, for the Almanac's limit resets
  clocks: WorldClock[]; // the world clocks (HudSettings.clocks)
}

/** Left column cap: mark + wordmark, on the SESSIONS head's own gutter, and at
 *  its end the fold. The week report that hung off its end moved to the right
 *  rail's USAGE tab. */
export function Brand({ folded = false, onFold, workspace }: { folded?: boolean; onFold?: () => void; workspace?: ReactNode }) {
  // Mystical.app: the cap is the window's title bar, and its traffic lights
  // are drawn here, not by AppKit (DashboardWindow hides the native ones): while
  // the mark's end of the cap is hovered the logo fades out and they fade in.
  const mac = isMacApp();
  const [hot, setHot] = useState(false);

  return (
    // Relative: the Mac's traffic lights sit absolute inside it.
    <div className="wco-bar brand" style={{ position: "relative", zIndex: 40, flex: "none", height: CAP_H, display: "flex", alignItems: "center", gap: 9, padding: "0 12px", minWidth: 0, borderBottom: CAP_LINE, animation: CAP_IN }}>
      {/* The lights' hover zone: the mark, the cap's full height, and out over
          its padding to the window's corner (margin -12, padding 12). Not the
          fold button's end — reaching for the fold shouldn't wake the lights.
          Folded there is no fold, and the zone is the whole cap. */}
      <div onMouseEnter={mac ? () => setHot(true) : undefined} onMouseLeave={mac ? () => setHot(false) : undefined}
           style={{ alignSelf: "stretch", display: "flex", alignItems: "center", flex: folded ? 1 : "none", margin: "0 -12px", padding: "0 12px" }}>
      {mac && <Lights show={hot} />}
      {/* No slide: the logo used to slide 66px right for the lights, and the
          workspace switch now sits where it landed. It fades out (drifting 8px,
          unfolded), then the lights fade in; on the way back they leave first,
          so the two are never on screen at once. Hidden, it lets clicks through
          to the lights under it. */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, margin: folded ? "0 auto" : undefined,
                    transform: hot && !folded ? "translate3d(8px,0,0)" : "translate3d(0,0,0)", opacity: hot ? 0 : 1,
                    pointerEvents: hot ? "none" : undefined,
                    transition: hot ? "opacity .1s ease-in, transform .2s cubic-bezier(.2,.8,.2,1)"
                                    : "opacity .18s ease-out .07s, transform .26s cubic-bezier(.2,.8,.2,1) .07s" }}>
      <svg
        viewBox="0 0 100 100"
        style={{ width: 19, height: 19, flex: "none", overflow: "visible" }}
      >
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="var(--acc)"
          strokeWidth="3"
          strokeDasharray="7 11"
          style={{ transformOrigin: "50px 50px", animation: "introspin 14s linear infinite" }}
        />
        <rect
          x="30"
          y="30"
          width="40"
          height="40"
          fill="none"
          stroke="var(--acc)"
          strokeWidth="3"
          style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
        />
        <rect
          x="41"
          y="41"
          width="18"
          height="18"
          fill="var(--crest, var(--purple))"
          style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
        />
      </svg>
      {!folded && (
        <span className="wordmark" style={{ fontSize: "var(--t12)", letterSpacing: "2.6px", color: "var(--txb)", whiteSpace: "nowrap" }}>
          <span className="bw-a">MYSTICAL</span><span className="bw-sep" style={{ color: "var(--acc)" }}>//</span><span className="bw-b" style={{ color: "var(--txd)" }}>ASSISTANT</span>
        </span>
      )}
      </div>
      </div>
      {!folded && onFold && (<>
        <span style={{ flex: 1, minWidth: 6 }} />
        {/* The workspace switch sits left of the fold (WorkspaceButton). */}
        {workspace}
        <FoldButton onClick={onFold} />
      </>)}
    </div>
  );
}

/** macOS traffic lights, the page's own: close hides the window (the app's
 *  rule), minimize miniaturizes, zoom goes full screen (Notifier "window").
 *  Glyphs while the group is hovered, like the real ones. Absolute at the
 *  cap's left edge, over where the logo was: in once it has faded, out first. */
export function Lights({ show }: { show: boolean }) {
  const [hover, setHover] = useState(false);
  const dots: [string, "close" | "minimize" | "zoom", LucideIcon][] = [
    ["#ff5f57", "close", X], ["#febc2e", "minimize", Minus], ["#28c840", "zoom", Plus],
  ];
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "absolute", left: 13, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 8, opacity: show ? 1 : 0, transition: show ? "opacity .16s ease-out .09s" : "opacity .08s ease", pointerEvents: show ? "auto" : "none" }}
    >
      {dots.map(([fill, action, Glyph]) => (
        <button
          key={action}
          aria-label={action}
          onClick={() => macWindow(action)}
          style={{
            appearance: "none", cursor: "default", width: 12, height: 12, borderRadius: 6, padding: 0, border: 0,
            background: fill, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.15)",
            display: "flex", alignItems: "center", justifyContent: "center", color: "#000",
          }}
        >
          {/* Drawn, not typed: a font's ×–+ sat ~1px low (its metrics, not the
              box); the icon's centre is the dot's. Opacity on the whole icon, so
              the ×'s crossing doesn't darken twice. */}
          {hover && <Glyph size={8} strokeWidth={3} style={{ opacity: 0.55 }} aria-hidden />}
        </button>
      ))}
    </div>
  );
}

/** Folds the sessions column to its rail — the right panel's fold, mirrored.
 *  The rail's own foot button unfolds it. */
function FoldButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick} aria-label="Fold the sidebar" title="Fold the sidebar to its rail"
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none", cursor: "pointer", border: 0, background: "transparent", padding: 0,
        flex: "none", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
        color: hover ? "var(--txb)" : "var(--txd)", transition: "color .15s ease",
      }}
    >
      <PanelLeftClose size={15} strokeWidth={1.9} aria-hidden />
    </button>
  );
}

/** Right column cap: the cluster over the panel, the gear over the rail.
 *  Collapsed there are no children — the column is the rail's 48px alone. */
export function RightCap({ onOpenSettings, children, railTop }: {
  onOpenSettings: () => void;
  children?: ReactNode;
  /** The Linux window: its close button takes the gear's cell, which then
   *  runs into the rail with no rule under it (the gear moves into the rail). */
  railTop?: ReactNode;
}) {
  const [gearHover, setGearHover] = useState(false);
  return (
    // position + z-index lift the cap's stacking context (its entry animation
    // makes one) above the panel under it, which would otherwise cover the
    // clock's popovers.
    <div className="rcap wco-bar" data-bare={children ? undefined : ""} style={{ position: "relative", zIndex: 40, display: "flex", height: CAP_H, borderBottom: CAP_LINE, animation: CAP_IN }}>
      {children && (
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", padding: "0 12px", borderLeft: "1px solid var(--border)" }}>
          {children}
        </div>
      )}
      {/* The rail's own width, hairline and ground, so the rail reads as
          running to the top. */}
      {railTop ? (
        // One pixel past the cap's rule, so the rail runs on under it unbroken.
        <div className="flex flex-col" style={{ width: 48, flex: "none", marginLeft: "auto", height: "calc(100% + 1px)", marginBottom: -1,
                      position: "relative", borderLeft: "1px solid var(--border)", background: "var(--panel3)" }}>
          {railTop}
        </div>
      ) : (
      <div style={{ width: 48, flex: "none", marginLeft: "auto", display: "flex", alignItems: "center", justifyContent: "center", borderLeft: "1px solid var(--border)", background: "var(--panel3)" }}>
        <button
          onClick={onOpenSettings}
          title="dashboard settings"
          onMouseEnter={() => setGearHover(true)}
          onMouseLeave={() => setGearHover(false)}
          style={{
            appearance: "none", cursor: "pointer", border: 0, background: "transparent",
            color: gearHover ? "var(--txb)" : "var(--txm)", fontFamily: "inherit",
            padding: 0, width: 26, height: 26,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
      )}
    </div>
  );
}

/** The clock & weather, the pinned world clocks, the bell: one row that sits
 *  wherever App puts it (RightCap, or the chat header while the right panel is
 *  collapsed). */
export function Strip({ clock, weather, accounts, clocks }: StripProps) {
  const [clockHover, setClockHover] = useState(false);
  const [open, setOpen] = useState(false);
  const h12 = useClock12();
  const anchorRef = useRef<HTMLSpanElement>(null);

  // It closes on a press anywhere outside the clock and its drop-down; Esc is the
  // Almanac's own, since there it first leaves the year view.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const [hh = "00", mm = "00"] = clock.split(":");
  const h24 = parseInt(hh, 10) || 0;
  const clockMini = h12 ? `${h24 % 12 || 12}:${mm}` : `${hh}:${mm}`;
  const ampm = h24 < 12 ? "AM" : "PM";
  // The cap reads the number alone, as the Almanac does; SETTINGS ▸ CLOCK & WEATHER picks the unit.
  const wxTemp = weather.temp === null ? "—" : `${weather.temp}°`;
  const pins = clocks.filter((c) => c.pin);

  const toggle = { onClick: () => setOpen((o) => !o), "aria-haspopup": "dialog" as const, "aria-expanded": open };
  const clockHov = { onMouseEnter: () => setClockHover(true), onMouseLeave: () => setClockHover(false) };
  const bare: CSSProperties = {
    appearance: "none", cursor: "pointer", border: 0, background: "transparent", padding: 0,
    fontFamily: "inherit", display: "flex", alignItems: "center", flex: "none",
  };

  return (
    // Relative here, not on the clock: the Almanac hangs off the cluster's
    // right edge, which stays inside the right column (or at the chat header's
    // end) wherever the clock itself sits.
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flex: "1 1 auto", minWidth: 0 }}>
      {/* "surface": right-click here is the plain dashboard menu in both homes,
          not the chat column's, whose root holds the clock while the panel is folded. */}
      <span ref={anchorRef} data-ctx-type="surface" style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
        {/* The one big readout. At t17 it outranks the chat's t14 title —
            chosen over a quieter split, 2026-09-11. */}
        <button {...toggle} title="the Almanac: calendar, weather, limit resets, world clocks" {...clockHov} style={{ ...bare, gap: 4, height: 26 }}>
          <span className="trim" style={{ fontFamily: "var(--mono)", fontSize: "var(--t17)", color: "var(--txb)", letterSpacing: ".4px" }}>
            {clockMini}
          </span>
          {h12 && (
            <span className="trim" style={{ fontSize: "var(--t8)", letterSpacing: "1px", color: "var(--txd)" }}>{ampm}</span>
          )}
        </button>
        {/* The weather beside it is the same handle. */}
        <button
          className="wx"
          {...toggle}
          title={`${[weather.cond, weather.loc].filter(Boolean).join(" · ") || "weather"} — the Almanac`}
          {...clockHov}
          style={{ ...bare, gap: 5, height: 13, color: "var(--txd)" }}
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" style={{ flex: "none" }}>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
          </svg>
          <span className="trim" style={{ fontFamily: "var(--mono)", fontSize: "var(--t95)", color: clockHover ? "var(--txh)" : "var(--txm)" }}>{wxTemp}</span>
        </button>
        {open && <Almanac weather={weather} accounts={accounts} clocks={clocks} h12={h12} onClose={() => setOpen(false)} />}
      </span>

      {/* The pinned world clocks take the row's spare width, and drop out
          whole when it's too narrow for them (index.css .stp-pinbox). */}
      {pins.length > 0 && (
        <span className="stp-pinbox">
          <span className="stp-pins">
            {pins.map((c) => {
              const t = zoneTime(c.zone, Date.now(), h12);
              return <span key={c.zone}><em>{zoneTag(c.zone)}</em>{t.time}{t.ampm && <small>{t.ampm}</small>}</span>;
            })}
          </span>
        </span>
      )}

      {/* The bell, by the gear. Git lives in the rail's GIT tab, and the
          platform's own UPDATE on the rail, above ⌘K. */}
      <span style={{ display: "flex", alignItems: "center", gap: 12, flex: "none" }}>
        <NotificationCenter />
      </span>
    </div>
  );
}

/** The Linux window's buttons (linux/window.py draws no title bar), down the
 *  right rail drawn like its tabs: close in the gear's cell at the very top
 *  (LinuxClose, RightCap's railTop), then maximize and minimize, a rule, and
 *  the gear (LinuxRailHead, RightPanel's railHead). They sat in the top-right
 *  corner first, as a title bar's do, and read as foreign chrome there. */
const LX_BTN = "flex h-[34px] w-full items-center justify-center text-muted-2 hover:bg-accent hover:text-primary";

export function LinuxClose() {
  return (
    <button type="button" className={`${LX_BTN} lxclose h-full`} aria-label="Close" title="Close" onClick={() => linuxWindow("close")}>
      <X size={16} strokeWidth={1.8} aria-hidden />
    </button>
  );
}

export function LinuxRailHead({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <>
      <button type="button" className={LX_BTN} aria-label="Maximize" title="Maximize" onClick={() => linuxWindow("maximize")}>
        <Square size={12} strokeWidth={1.8} aria-hidden />
      </button>
      <button type="button" className={LX_BTN} aria-label="Minimize" title="Minimize" onClick={() => linuxWindow("minimize")}>
        <Minus size={15} strokeWidth={1.8} aria-hidden />
      </button>
      <div className="my-1 border-t border-border" aria-hidden />
      <button type="button" className={LX_BTN} aria-label="Dashboard settings" title="dashboard settings" onClick={onOpenSettings}>
        <Settings size={15} strokeWidth={1.6} aria-hidden />
      </button>
    </>
  );
}
