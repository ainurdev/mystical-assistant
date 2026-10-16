/** What the transcript shows while the agent works: the braille spinner with its
 *  level bars, one quiet status line, or the nyan cat's ride. A stored pick from
 *  the forms the settings remap (2026-10-15) retired (piano, tiles) lands on the
 *  spinner. */
export const INDICATORS = ["bar", "status", "nyan"] as const;
export type Indicator = (typeof INDICATORS)[number];

export function toIndicator(v: unknown): Indicator {
  return INDICATORS.find((i) => i === v) ?? "bar";
}
