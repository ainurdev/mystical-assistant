// Search in this chat (components/ChatSearch), the pure half. The bridge answers prompts
// first and then events, each in store order (bridge/chat_search.in_chat), so the hits
// are put back in reading order here for next and previous to mean anything.

export type ChatHit = { turn: string; kind: string; seq: number | null; snippet: string; at?: number };

/** In transcript order: by turn, a turn's prompt before what came of it. A turn this
 *  page doesn't know yet (paged out, or just begun) sorts by nothing and keeps its place
 *  among its own. */
export function orderHits(hits: ChatHit[], turnIds: string[]): ChatHit[] {
  const at = new Map(turnIds.map((id, i) => [id, i]));
  // A turn's closing words are stored twice, streamed and as its result, and only the
  // result draws: the same words are one hit.
  const answers = new Set(hits.filter((h) => h.kind === "result").map((h) => `${h.turn}\n${h.snippet}`));
  return hits
    .filter((h) => h.kind !== "text" || !answers.has(`${h.turn}\n${h.snippet}`))
    .map((h, i) => ({ h, i, t: at.get(h.turn) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.t - b.t || (a.h.seq ?? -1) - (b.h.seq ?? -1) || a.i - b.i)
    .map((x) => x.h);
}

/** Next or previous, wrapping. -1: nothing picked yet, so next is the first and previous the last. */
export function stepHit(at: number, count: number, d: 1 | -1): number {
  if (!count) return -1;
  if (at < 0) return d === 1 ? 0 : count - 1;
  return (at + d + count) % count;
}

/** The snippet cut around what you typed, to mark it. */
export function snippetParts(snippet: string, q: string): { t: string; hit: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ t: snippet, hit: false }];
  const low = snippet.toLowerCase();
  const out: { t: string; hit: boolean }[] = [];
  let from = 0;
  for (;;) {
    const i = low.indexOf(needle, from);
    if (i < 0) break;
    if (i > from) out.push({ t: snippet.slice(from, i), hit: false });
    out.push({ t: snippet.slice(i, i + needle.length), hit: true });
    from = i + needle.length;
  }
  if (from < snippet.length) out.push({ t: snippet.slice(from), hit: false });
  return out;
}

export function hitWord(kind: string): string {
  return kind === "prompt" ? "You" : kind === "steer" ? "Steer" : kind === "result" ? "Answer" : "Note";
}

/** Fewer than this the bridge doesn't look. */
export const MIN_QUERY = 2;
