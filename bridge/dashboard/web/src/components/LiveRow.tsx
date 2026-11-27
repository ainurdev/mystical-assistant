/** The current action as the chat's last row (.mystical/design-drafts/chat-notes-live).
 *
 *  The running WORK zone (RunStream WorkZone) used to carry its NowLine inside its
 *  header, so the line scrolled away with the header and the prompt box's pill said
 *  it a second time. Now the zone hands the line to this row, which Terminal hosts
 *  at the foot of the transcript: in flow it reads as the last message; scrolled up,
 *  the host is `position: sticky; bottom: 0`, so the row stays on screen and offers
 *  the way back down. It owns the turn's Pause and Stop (the pill no longer does).
 *
 *  Why a portal and not a row in the turn: the transcript is virtualized, and a
 *  sticky row only sticks inside its own turn's box; the host sits outside both.
 *  Without a host (a ticket tile, the agents view) the zone keeps its line inline. */
import { createContext, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, Pause, Play, Square } from "lucide-react";
import { turnClock } from "../lib/boxdeck";

export type LiveHost = {
  host: HTMLElement | null;
  atBottom: boolean;
  onJump: () => void;
  onStop?: () => void;
  paused?: boolean;
  onTogglePause?: () => void;
  /** +1 when a row mounts in `host`, -1 when it goes: the host's owner marks the page by it (no `:has()`) */
  onRow?: (delta: number) => void;
};

export const LiveHostCtx = createContext<LiveHost | null>(null);

export function LiveRow({ live, line, turnSecs }: { live: LiveHost & { host: HTMLElement }; line: ReactNode; turnSecs: number | null }) {
  const onRow = live.onRow;
  useLayoutEffect(() => { onRow?.(1); return () => onRow?.(-1); }, [onRow]);
  return createPortal(
    <div className="live-row" data-away={live.atBottom ? undefined : ""}>
      {/* the spine's branch into the box: before the ring, so the ring's glow paints over it */}
      <span className="live-branch" aria-hidden />
      <div className="live-ring">
        <span className="live-spin" aria-hidden />
        {/* scrolled up, the card itself is the way back down too */}
        <div className="live-card" onClick={(e) => { if (!live.atBottom && !(e.target as Element).closest("button")) live.onJump(); }}>
          {line}
          {turnSecs != null ? <span className="live-turn" title="This turn so far">turn {turnClock(turnSecs)}</span> : null}
          {!live.atBottom ? (
            <button type="button" className="live-btn live-jump" onClick={live.onJump} title="Jump to the latest">
              <ArrowDown size={12} strokeWidth={2.4} aria-hidden />Latest</button>
          ) : null}
          {live.onTogglePause ? (
            <button type="button" className="live-btn" data-armed={live.paused ? "" : undefined} onClick={live.onTogglePause}
              aria-label={live.paused ? "Resume" : "Pause"}
              title={live.paused ? "PAUSED — nothing starts after this turn. Click to resume."
                : "PAUSE — let this turn finish, then hold; no queued prompt or goal nudge starts after it"}>
              {live.paused ? <Play size={11} strokeWidth={0} fill="currentColor" aria-hidden /> : <Pause size={11} strokeWidth={0} fill="currentColor" aria-hidden />}</button>
          ) : null}
          {live.onStop ? (
            <button type="button" className="live-btn" onClick={live.onStop} aria-label="Stop" title="STOP — interrupt this turn now">
              <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden /></button>
          ) : null}
        </div>
      </div>
    </div>,
    live.host,
  );
}
