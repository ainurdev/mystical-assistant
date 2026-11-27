/** What the transcript shows while the agent works: one quiet status line, or
 *  the nyan cat's ride. A stored pick of a retired form (piano, tiles: the
 *  settings remap, 2026-10-15; the equalizer "bar": 2026-10-18; ORBIT, the
 *  comet on the WORK card's node: 2026-11-28, once the live row's border
 *  became the chat's one light) lands on STATUS. */
export const INDICATORS = ["status", "nyan"] as const;
export type Indicator = (typeof INDICATORS)[number];

export function toIndicator(v: unknown): Indicator {
  return INDICATORS.find((i) => i === v) ?? "status";
}
