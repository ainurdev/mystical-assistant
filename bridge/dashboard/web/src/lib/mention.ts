/** @-mentions in the prompt box: find the mention under the caret, rank the
 *  repo's paths against it.
 *
 *  Plain text, not chips — the model reads `bridge/runner.py` as well as any
 *  widget would, and a chip needs a rich-text editor the composer doesn't have.
 */

export interface Mention {
  /** What's been typed after the `@`, lowercased for matching. */
  q: string;
  /** Index of the `@` itself, so a pick can splice from there to the caret. */
  start: number;
}

/** The mention the caret is sitting in, if any. An `@` only opens a mention at
 *  the start of a word — `foo@bar.com` and `a@b` are not file references. */
export function mentionAt(text: string, caret: number): Mention | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const q = upto.slice(at + 1);
  // A space ends the mention; so does a newline. Paths have neither.
  if (/\s/.test(q)) return null;
  return { q: q.toLowerCase(), start: at };
}

/** Paths worth offering for `q`, best first.
 *
 *  Ranking, in order: the basename starts with the query, the basename contains
 *  it, the full path contains it. Ties break on the shorter path, because the
 *  file you mean is usually nearer the root than its test fixture is.
 */
export function rankPaths(paths: string[], q: string, limit = 8): string[] {
  if (!q) return paths.slice(0, limit);
  const scored: { p: string; s: number }[] = [];
  for (const p of paths) {
    const low = p.toLowerCase();
    const base = low.slice(low.lastIndexOf("/") + 1);
    const s = base.startsWith(q) ? 0 : base.includes(q) ? 1 : low.includes(q) ? 2 : -1;
    if (s >= 0) scored.push({ p, s });
  }
  scored.sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p));
  return scored.slice(0, limit).map((x) => x.p);
}

/** Text with the mention under the caret replaced by `path`, and where the caret
 *  goes afterwards (just past the inserted path and its trailing space). */
export function applyMention(
  text: string, m: Mention, caret: number, path: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, m.start)}${path} ${text.slice(caret)}`;
  return { text: next, caret: m.start + path.length + 1 };
}
