// The search sheet's pure half. The bridge returns one hit per event, and a turn's
// closing words are stored twice (streamed as text, again as the result), so the same
// line would list twice.

export type SearchHit = { turn: string; kind: string; seq: number | null; snippet: string; at?: number };

export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = `${h.turn}\n${h.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** A snippet cut around each match, ignoring case, for marking up. */
export function markParts(text: string, q: string): { text: string; hit: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const low = text.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (let i = low.indexOf(needle); i >= 0; i = low.indexOf(needle, at)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

export const hitWho: Record<string, string> = { prompt: "YOU", steer: "YOU", text: "AGENT", result: "ANSWER" };
