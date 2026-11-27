// The Spin-off card's arithmetic (components/SpinOffCard; bridge/spinoffs.py). Pure, for its check.
import type { SpinRow } from "../api.ts";

/** The place a row with no checkout goes when you pick Clone & start, as the bridge's tap names it. */
export const CLONE = "clone";

/** The cards a turn offered, in the order it offered them. */
export function spinCardsOf(events: readonly { type: string; card?: string }[]): string[] {
  const out: string[] = [];
  for (const e of events) if (e.type === "spinoffs" && e.card && !out.includes(e.card)) out.push(e.card);
  return out;
}

/** Gone to its project: a chip on the ✓ line now, no longer a row of the card. */
export const gone = (r: SpinRow): boolean => r.state === "started" || r.state === "waiting" || r.state === "parked";

/** Ticked when the card first shows: a row that can go as it is. A repeat has no tick, a row with no
 *  checkout starts unticked so START never clones unless you tick it, and one with no project waits for you. */
export const tickedAtFirst = (r: SpinRow): boolean => r.state === "open" && !r.repeat && !!r.project;

/** A row a tap can take: open, or failed and tried again. A repeat links to its session instead. */
export const tappable = (r: SpinRow): boolean => (r.state === "open" || r.state === "failed") && !r.repeat;

/** How many projects the header names: the distinct places the rows go, a repo to clone counted as one. */
export function placeCount(rows: readonly SpinRow[], placeOf: (r: SpinRow) => string): number {
  return new Set(rows.map(placeOf).filter(Boolean)).size;
}

/** A row's keys as its second line shows them: the first in full, the others without the prefix they
 *  share with it, so three Sentry issues read "RIVENDELL-4Q2 · 4Q5 · 4Q9". */
export function shortKeys(keys: readonly string[]): string[] {
  const pre = /^(.*-)[^-]+$/.exec(keys[0] ?? "")?.[1] ?? "";
  return keys.map((k, i) => (i && pre && k.startsWith(pre) && k.length > pre.length ? k.slice(pre.length) : k));
}

const TRACKERS = /sentry|github|gitlab|linear|jira|rivendell|issue|bug/i;

/** "3 issues" when they came from a tracker, "2 sources" otherwise; "" for a row with none. */
export function sourceCount(sources: SpinRow["sources"]): string {
  const n = sources.length;
  if (!n) return "";
  const word = sources.every((s) => TRACKERS.test(s.kind)) ? "issue" : "source";
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** START n and PARK n: the ticked rows a tap can take that have somewhere to go. PARK can't take a row
 *  whose only place is a clone: a Task needs a checkout to be filed in. */
export function counts(rows: readonly SpinRow[], ticked: ReadonlySet<number>, placeOf: (r: SpinRow) => string) {
  const on = rows.filter((r) => ticked.has(r.n) && tappable(r));
  const placed = on.filter((r) => placeOf(r));
  return { start: placed.length, park: placed.filter((r) => placeOf(r) !== CLONE).length };
}
