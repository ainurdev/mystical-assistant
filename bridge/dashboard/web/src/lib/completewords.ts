// What the composer offers to complete (components/MarkdownInput): the code-like words this chat has
// used, newest first, and the project's files. Plain English isn't offered: a list popping up on
// every "the" is noise, while `workrun.py`, `chat_plan` or `useRefSession` are slow to type exactly.

export type Turnish = { prompt?: string; events?: { type: string; text?: string; result?: string }[] };

const MIN = 4;
const MAX_LEN = 80;
// Paths and dotted names (bridge/work.py, a.b.c), snake_case, kebab-case with a digit or two parts,
// camelCase and PascalCase with an inner capital, and --flags.
const CODE = /(?<![\w$@/.-])(?:--?[a-z][\w-]{2,}|[A-Za-z_$][\w$]*(?:[./][\w$-]+)+|[A-Za-z][\w$]*_[\w$]+|[a-z][a-z0-9]*[A-Z][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*|[a-z][a-z0-9]*(?:-[a-z0-9]+){2,})/g;
const TICKS = /`([^`\n]{2,80})`/g;

function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TICKS)) {
    const inner = m[1].trim();
    if (!/\s/.test(inner)) out.push(inner);
  }
  for (const m of text.matchAll(CODE)) out.push(m[0].replace(/[.,:;)]+$/, ""));
  return out.filter((w) => w.length >= MIN && w.length <= MAX_LEN);
}

/** The chat's code-like words, newest first, each once. Only the last `turns` turns are read. */
export function codeWords(turns: Turnish[], limit = 3000, last = 80): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of turns.slice(-last).reverse()) {
    const texts = [...(t.events ?? []).map((e) => (e.type === "result" ? e.result : e.type === "text" ? e.text : "") ?? "").reverse(), t.prompt ?? ""];
    for (const text of texts) {
      for (const w of wordsOf(text)) {
        if (seen.has(w)) continue;
        seen.add(w);
        out.push(w);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** The word being typed: what ends at the caret, and where it starts. Null where another list owns
 *  the keys: an `@mention`, or a `/command` at the start of a line. */
export function wordAt(line: string, col: number): { from: number; word: string } | null {
  const m = /[\w$./-]+$/.exec(line.slice(0, col));
  if (!m) return null;
  const from = col - m[0].length;
  if (line[from - 1] === "@") return null;
  if (m[0].startsWith("/") && !line.slice(0, from).trim()) return null;
  return { from, word: m[0] };
}

export type Option = { label: string; detail?: string; kind: "word" | "file"; boost: number };

/** What's offered for a word, best first: words the chat used, then files, both by prefix (any case),
 *  then by the word appearing inside. Never the word itself. */
export function rank(word: string, words: string[], files: string[], max = 40): Option[] {
  const q = word.toLowerCase();
  if (q.length < 3) return [];
  const out: Option[] = [];
  const have = new Set<string>();
  const add = (o: Option) => { if (o.label !== word && !have.has(o.label)) { have.add(o.label); out.push(o); } };
  const pathy = word.includes("/");
  const score = (s: string) => (s.toLowerCase().startsWith(q) ? 2 : s.toLowerCase().includes(q) ? 1 : 0);
  words.forEach((w, i) => { const s = score(w); if (s) add({ label: w, kind: "word", boost: s * 100 - Math.min(i, 99) }); });
  for (const f of files) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    const label = pathy ? f : base;
    const s = score(label);
    if (s) add({ label, detail: pathy ? undefined : f.slice(0, Math.max(0, f.lastIndexOf("/"))) || undefined, kind: "file", boost: s * 100 - 50 });
    if (out.length > 400) break;
  }
  return out.sort((a, b) => b.boost - a.boost || a.label.length - b.label.length).slice(0, max);
}
