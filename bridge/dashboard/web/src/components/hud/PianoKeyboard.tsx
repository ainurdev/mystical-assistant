import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { BY_CHAR, KEYS, WHITE_COUNT, whiteIndex } from "../../lib/piano";

export const WHITE_W = 17;
export const BLACK_W = 11;
export const KEY_H = 46;
export const BOARD_W = WHITE_COUNT * WHITE_W;

/** Where a key's lane sits horizontally — shared by the keys and the falling
 *  tiles, so a tile is always dead-centre over the key that clears it. */
export function laneOf(midi: number): { left: number; width: number } {
  const i = KEYS.findIndex((k) => k.midi === midi);
  if (i < 0) return { left: 0, width: WHITE_W };
  const w = whiteIndex(i);
  return KEYS[i].black
    ? { left: w * WHITE_W - BLACK_W / 2, width: BLACK_W }
    : { left: w * WHITE_W, width: WHITE_W };
}

/**
 * The two-octave board. Owns focus and the computer-key mapping; what a press
 * MEANS is the caller's business — free play just sounds the note, the tiles
 * game scores it first.
 */
export function PianoKeyboard({
  held,
  onPress,
  onRelease,
  onLive,
  tint,
  labels = true,
  children,
}: {
  held: number[];
  onPress: (midi: number) => void;
  onRelease: (midi: number) => void;
  onLive?: (live: boolean) => void;
  /** Optional per-key override, e.g. flashing the key a tile just landed on. */
  tint?: (midi: number) => string | undefined;
  labels?: boolean;
  /** Rendered above the keys, in the same coordinate space (the tile field). */
  children?: ReactNode;
}) {
  const dragging = useRef(false);

  return (
    <div
      role="application"
      aria-label="piano"
      tabIndex={0}
      // The keys preventDefault to stop text-selection drag, which also
      // suppresses the implicit focus — so take focus here, on the bubble.
      onPointerDown={(e) => e.currentTarget.focus()}
      onPointerUp={() => (dragging.current = false)}
      onFocus={() => onLive?.(true)}
      onBlur={() => onLive?.(false)}
      onKeyDown={(e) => {
        const midi = BY_CHAR[e.key.toLowerCase()];
        if (midi === undefined) return;
        e.preventDefault();
        if (!e.repeat) onPress(midi);
      }}
      onKeyUp={(e) => {
        const midi = BY_CHAR[e.key.toLowerCase()];
        if (midi !== undefined) onRelease(midi);
      }}
      className="relative flex-none outline-none ring-primary focus-visible:ring-1"
      style={{ width: BOARD_W }}
    >
      {children}
      <div className="relative" style={{ height: KEY_H }}>
        {/* Whites lay out in a row; blacks straddle the seams above them. */}
        <div className="absolute inset-0 flex">
          {KEYS.filter((k) => !k.black).map((k) => (
            <Key
              key={k.midi}
              k={k}
              on={held.includes(k.midi)}
              tint={tint?.(k.midi)}
              labels={labels}
              onPress={onPress}
              onRelease={onRelease}
              dragging={dragging}
            />
          ))}
        </div>
        {KEYS.map((k, i) =>
          k.black ? (
            <Key
              key={k.midi}
              k={k}
              on={held.includes(k.midi)}
              tint={tint?.(k.midi)}
              labels={labels}
              onPress={onPress}
              onRelease={onRelease}
              dragging={dragging}
              left={whiteIndex(i) * WHITE_W - BLACK_W / 2}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function Key({
  k,
  on,
  tint,
  left,
  labels,
  onPress,
  onRelease,
  dragging,
}: {
  k: { midi: number; name: string; char: string; black: boolean };
  on: boolean;
  tint?: string;
  left?: number;
  labels: boolean;
  onPress: (m: number) => void;
  onRelease: (m: number) => void;
  dragging: RefObject<boolean>;
}) {
  const common = {
    title: `${k.name} · ${k.char.toUpperCase()}`,
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault(); // keep focus on the board so the keyboard stays live
      dragging.current = true;
      onPress(k.midi);
    },
    onPointerEnter: () => dragging.current && onPress(k.midi),
    onPointerUp: () => onRelease(k.midi),
    onPointerLeave: () => onRelease(k.midi),
  };
  if (k.black) {
    return (
      <span
        {...common}
        className="absolute top-0 z-10 cursor-pointer border border-black/70 transition-[background] duration-75"
        style={{
          left,
          width: BLACK_W,
          height: KEY_H * 0.62,
          background: tint ?? (on ? "var(--acc)" : "#14181a"),
        }}
      />
    );
  }
  return (
    <span
      {...common}
      className="flex flex-1 cursor-pointer items-end justify-center border-r border-black/25 pb-[2px] text-[7px] leading-none transition-[background] duration-75 last:border-r-0"
      style={{
        background: tint ?? (on ? "var(--acc)" : "#e8eceb"),
        color: on || tint ? "var(--acc-on)" : "#8a9694",
      }}
    >
      {labels ? k.char.toUpperCase() : ""}
    </span>
  );
}
