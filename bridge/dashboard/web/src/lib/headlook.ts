/**
 * SETTINGS ▸ CHAT ▸ HEADER: how the chat's header island looks
 * (.mystical/design-drafts/header-switch, A · ONE PILL, picked 2026-11-17).
 *
 * The fade is a mask on the transcript's scroller, not a gradient laid over
 * it: an overlay has to guess the ground's colour, and the grounds (THE
 * GROUND's patterns, a family's sheet) are not one colour. A mask fades the
 * words into whatever is behind them.
 *
 * Beside a pill (COMPACT) the words have to be gone by the pill's bottom edge,
 * since the row beside it is open: that was the bug, a half line of chat
 * running in next to the pill. Under a full-width bar the bar's own glass hides
 * what is above its edge, so the fade only has to end where a pinned WORK
 * header starts (the bar's bottom + 6, Terminal's --isle-b), which keeps those
 * headers and the transcript's scroll-margin anchors out of it.
 */
export type HeadShape = "pill" | "bar";
export type HeadFade = "off" | "soft" | "deep";
export type HeadGlass = "clear" | "frosted" | "solid";

export interface HeadLook {
  shape: HeadShape; // COMPACT only: a pill on the right, or a bar across the top
  fade: HeadFade;
  glass: HeadGlass;
  hide: boolean; // slides away while you scroll down, back on scroll up
  last: boolean; // the LAST row: the turn you are inside, and a jump to the end
  search: boolean; // the header's ⌕
}

export const HEAD_DEFAULT: HeadLook = { shape: "pill", fade: "soft", glass: "frosted", hide: false, last: true, search: true };

const pick = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);

export function toHead(v: unknown): HeadLook {
  const p = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    shape: pick(p.shape, ["pill", "bar"] as const, HEAD_DEFAULT.shape),
    fade: pick(p.fade, ["off", "soft", "deep"] as const, HEAD_DEFAULT.fade),
    glass: pick(p.glass, ["clear", "frosted", "solid"] as const, HEAD_DEFAULT.glass),
    hide: p.hide === true,
    last: p.last !== false,
    search: p.search !== false,
  };
}

const LEN: Record<Exclude<HeadFade, "off">, number> = { soft: 24, deep: 44 };

/** Where the words fade, in px from the scroller's top: gone above `from`,
 *  whole from `to`. `bottom` is the header's bottom edge; `beside` is true
 *  when the header is a pill with open column beside it. */
export function fadeBand(fade: HeadFade, bottom: number, beside: boolean): { from: number; to: number } | null {
  if (fade === "off") return null;
  const len = LEN[fade];
  return beside ? { from: bottom, to: bottom + len } : { from: bottom + 6 - len, to: bottom + 6 };
}

export const fadeMask = (b: { from: number; to: number }) =>
  `linear-gradient(to bottom, transparent ${b.from}px, #000 ${b.to}px)`;
