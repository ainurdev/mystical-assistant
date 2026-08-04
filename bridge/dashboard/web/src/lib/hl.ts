import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightTree } from "@lezer/highlight";

/* Static syntax highlighting for fenced code blocks in a response, using the
   same CodeMirror grammars the editor already loads on demand (see langfor.ts) —
   no second highlighter, no new dependency. Emits `tok-*` classes (coloured in
   the `.md` block of index.css) so the markup stays plain spans. */

export type Tok = { text: string; cls: string };

// Beyond this a block is a pasted log, not code worth parsing on the main thread.
const MAX = 20_000;

export async function tokenize(code: string, lang: string): Promise<Tok[] | null> {
  const desc = lang && code.length <= MAX
    ? LanguageDescription.matchLanguageName(languages, lang, true)
    : null;
  if (!desc) return null;
  const support = desc.support ?? (await desc.load());
  const out: Tok[] = [];
  let pos = 0;
  highlightTree(support.language.parser.parse(code), classHighlighter, (from, to, cls) => {
    if (from > pos) out.push({ text: code.slice(pos, from), cls: "" });
    out.push({ text: code.slice(from, to), cls });
    pos = to;
  });
  if (pos < code.length) out.push({ text: code.slice(pos), cls: "" });
  return out;
}
