/** What the transcript shows while the agent works: the braille spinner with its
 *  level bars, one quiet status line, the nyan cat's ride, or ORBIT — the WORK
 *  card itself, a comet on its node's ring while a tool runs and a ripple in it
 *  while the model thinks. A stored pick from the forms the settings remap
 *  (2026-10-15) retired (piano, tiles) lands on the spinner. */
export const INDICATORS = ["bar", "status", "nyan", "orbit"] as const;
export type Indicator = (typeof INDICATORS)[number];

export function toIndicator(v: unknown): Indicator {
  return INDICATORS.find((i) => i === v) ?? "bar";
}
