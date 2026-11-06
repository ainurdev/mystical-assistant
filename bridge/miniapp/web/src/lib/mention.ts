// The composer's `@` typeahead over profile names. A profile you @ is final
// (plan, decision 8), and the bridge matches the name as typed, spaces included
// (channel._mentions: "@Work Opus" beats "@Work"), so a query can hold a space and
// runs from the @ to the caret. A query no name fits closes the list. Pure.

export type AtQuery = { start: number; q: string };

const MAX_QUERY = 40;

/** The mention being typed at the caret, or null. The @ must start a word, the
 *  bridge's own rule: `foo@bar` is an address. */
export function atQuery(draft: string, caret: number): AtQuery | null {
  const head = draft.slice(0, caret);
  const start = head.lastIndexOf("@");
  if (start < 0 || caret - start - 1 > MAX_QUERY) return null;
  if (start > 0 && /[\w@]/.test(head[start - 1])) return null;
  const q = head.slice(start + 1);
  return /\n/.test(q) ? null : { start, q };
}

/** Names worth offering for `q`, best first: starts with it, then a later word
 *  does, then it appears anywhere. */
export function rankNames<T extends { name: string }>(items: T[], q: string): T[] {
  const low = q.toLowerCase();
  const scored: { it: T; s: number }[] = [];
  for (const it of items) {
    const n = it.name.toLowerCase();
    const s = n.startsWith(low) ? 0 : n.split(/\s+/).some((w) => w.startsWith(low)) ? 1 : n.includes(low) ? 2 : -1;
    if (s >= 0) scored.push({ it, s });
  }
  scored.sort((a, b) => a.s - b.s || a.it.name.localeCompare(b.it.name));
  return scored.map((x) => x.it);
}

/** Whether `q` is already this name, so Enter sends rather than re-inserting it. */
export const isWholeName = (name: string, q: string) => name.toLowerCase() === q.toLowerCase();

/** The draft with the mention completed, and where the caret goes. */
export function insertName(draft: string, at: AtQuery, caret: number, name: string): { text: string; caret: number } {
  const lead = `${draft.slice(0, at.start)}@${name} `;
  return { text: lead + draft.slice(caret).replace(/^ /, ""), caret: lead.length };
}
