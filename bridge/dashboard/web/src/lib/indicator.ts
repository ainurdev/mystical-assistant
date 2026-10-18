/** What the transcript shows while the agent works: one quiet status line, the
 *  nyan cat's ride, or ORBIT — the WORK card itself, a comet on its node's ring
 *  while a tool runs and a ripple in it while the model thinks. A stored pick
 *  of a retired form (piano, tiles: the settings remap, 2026-10-15; the
 *  equalizer "bar": 2026-10-18) lands on ORBIT. */
export const INDICATORS = ["status", "nyan", "orbit"] as const;
export type Indicator = (typeof INDICATORS)[number];

export function toIndicator(v: unknown): Indicator {
  return INDICATORS.find((i) => i === v) ?? "orbit";
}
