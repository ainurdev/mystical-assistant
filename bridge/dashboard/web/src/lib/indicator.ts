/** What the transcript shows while the agent works. Two forms since the
 *  settings remap (2026-10-15): the braille spinner with its level bars, or one
 *  quiet status line. A stored pick from the retired forms (nyan, piano,
 *  tiles) lands on the spinner. */
export const INDICATORS = ["bar", "status"] as const;
export type Indicator = (typeof INDICATORS)[number];

export function toIndicator(v: unknown): Indicator {
  return v === "status" ? "status" : "bar";
}
