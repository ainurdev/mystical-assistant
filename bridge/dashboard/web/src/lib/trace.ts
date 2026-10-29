/* Go to definition, references and back/forward for the EDITOR, without a
   language server. The answers come from three places, best first: the file's
   own syntax tree (lib/symbols), the file's import lines (resolved against the
   repo's file list here), and `git grep` on the bridge (`/local/files/grep`,
   modes `def` and `word`). That is exact for imports and for names in the open
   file, and name-based across files: two `save()`s in different modules both
   answer. ponytail: a language server (docs/superpowers/plans/editor-parity.md,
   Task 6) makes it exact; the UI wouldn't change.

   Pure and DOM-free so trace.check.ts can run it under plain node. */

export interface Loc { path: string; line: number }
export interface Hit { path: string; line: number; text: string }

const IDENT = /[A-Za-z0-9_$]/;

/** The identifier touching column `col` of `text` (either side of the cursor). */
export function wordAt(text: string, col: number): { word: string; from: number; to: number } | null {
  let from = col, to = col;
  while (from > 0 && IDENT.test(text[from - 1])) from--;
  while (to < text.length && IDENT.test(text[to])) to++;
  const word = text.slice(from, to);
  return /^[A-Za-z_$][\w$]*$/.test(word) ? { word, from, to } : null;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function join(dir: string, rel: string): string {
  const out = dir ? dir.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

const JS_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".d.ts", "/index.ts", "/index.tsx", "/index.js"];

/** The repo file `name` is imported from, in the file at `fromPath`: ES
 *  `import { a as name } from "./x"`, `import name from`, `import * as name
 *  from`, and Python `from pkg.mod import name`. A package (`react`, `os`) or
 *  a path missing from `files` is null — nothing in this repo to open. */
export function importSource(doc: string, name: string, fromPath: string, files: Iterable<string>): string | null {
  const have = files instanceof Set ? files as Set<string> : new Set(files);
  const pick = (base: string, exts: string[]) => exts.map((e) => base + e).find((p) => have.has(p)) ?? null;
  // [^;"']: never run past a statement or a side-effect `import "./x.css"`.
  const es = /import\s+(?:type\s+)?([^;"']*?)\s+from\s+["']([^"']+)["']/g;
  for (let m = es.exec(doc); m; m = es.exec(doc)) {
    const [, what, spec] = m;
    const named = /\{([\s\S]*)\}/.exec(what)?.[1] ?? "";
    const locals = named.split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim());
    const dflt = /^\s*([A-Za-z_$][\w$]*)/.exec(what.replace(/\{[\s\S]*\}/, ""))?.[1];
    const star = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(what)?.[1];
    if (!locals.includes(name) && dflt !== name && star !== name) continue;
    if (!spec.startsWith(".")) return null;
    return pick(join(dirOf(fromPath), spec), JS_EXT);
  }
  const py = /\bfrom\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|[^\n]*)/g;
  for (let m = py.exec(doc); m; m = py.exec(doc)) {
    const [, dots, mod, names] = m;
    const locals = names.replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
    if (!locals.includes(name)) continue;
    let base = dots ? dirOf(fromPath) : "";
    for (let i = 1; i < dots.length; i++) base = dirOf(base);
    const path = join(base, mod.split(".").join("/"));
    return pick(path, [".py", "/__init__.py"]);
  }
  return null;
}

/** Definition hits, best first: the file the name is imported from, then the
 *  open file, then the rest by how much of the open file's path they share. */
export function rankDefs(hits: Hit[], fromPath: string, source: string | null): Hit[] {
  const shared = (p: string) => { let i = 0; while (i < p.length && p[i] === fromPath[i]) i++; return i; };
  const score = (h: Hit) => (h.path === source ? 2e6 : h.path === fromPath ? 1e6 : shared(h.path));
  const seen = new Set<string>();
  return [...hits]
    .sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path) || a.line - b.line)
    .filter((h) => { const k = `${h.path}:${h.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const COMMENT = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
const indent = (l: string) => /^\s*/.exec(l)![0].length;

/** The lines worth showing for a definition on line `line` (1-based): the
 *  comment right above it, the definition, and its body until the indentation
 *  comes back (the closing brace included), at most `max` lines. [first, last]. */
export function defSpan(lines: string[], line: number, max = 14): [number, number] {
  const i = Math.min(Math.max(line - 1, 0), lines.length - 1);
  let s = i;
  while (s > 0 && i - s < 12) {
    if (COMMENT.test(lines[s - 1])) { s--; continue; }
    // The end of a /* … */ whose middle lines don't start with `*`.
    const open = /\*\/\s*$/.test(lines[s - 1]) ? lines.slice(Math.max(0, s - 12), s).map((l) => l.includes("/*")).lastIndexOf(true) : -1;
    if (open < 0) break;
    s = Math.max(0, s - 12) + open;
  }
  const base = indent(lines[i]);
  let e = i;
  for (let k = i + 1; k < lines.length && k - i < max; k++) {
    const l = lines[k];
    if (!l.trim()) { e = k; continue; }
    if (indent(l) <= base) { if (/^\s*[}\])]/.test(l)) e = k; break; }
    e = k;
  }
  while (e > i && !lines[e].trim()) e--;
  return [s + 1, e + 1];
}

/** A definition's one-line signature and the comment above it, for the hover. */
export function signature(lines: string[], line: number): { sig: string; doc: string } {
  const [first] = defSpan(lines, line, 1);
  const doc = lines.slice(first - 1, line - 1)
    .map((l) => l.trim().replace(/^(\/\*\*?|\*\/|\*|\/\/|#|"""|''')\s*/, "").replace(/\s*\*\/$/, ""))
    .filter(Boolean).join(" ");
  const sig = (lines[line - 1] ?? "").trim().replace(/\s*[{:]\s*$/, "").replace(/^export\s+(default\s+)?/, "");
  return { sig, doc };
}

/** Back/forward, VS Code's navigation history, as plain data. */
export interface Nav { back: Loc[]; fwd: Loc[] }
export const NAV0: Nav = { back: [], fwd: [] };
const near = (a: Loc, b: Loc) => a.path === b.path && Math.abs(a.line - b.line) < 3;

/** A jump is about to leave `from`: remember it, and forget the way forward. */
export function navPush(nav: Nav, from: Loc): Nav {
  const top = nav.back[nav.back.length - 1];
  return { back: top && near(top, from) ? nav.back : [...nav.back, from].slice(-50), fwd: [] };
}
export function navBack(nav: Nav, here: Loc): [Nav, Loc | null] {
  const to = nav.back[nav.back.length - 1];
  return to ? [{ back: nav.back.slice(0, -1), fwd: [...nav.fwd, here] }, to] : [nav, null];
}
export function navFwd(nav: Nav, here: Loc): [Nav, Loc | null] {
  const to = nav.fwd[nav.fwd.length - 1];
  return to ? [{ back: [...nav.back, here], fwd: nav.fwd.slice(0, -1) }, to] : [nav, null];
}

/** Hits by file, files in the order they first appear. */
export function byFile(hits: Hit[]): [string, Hit[]][] {
  const m = new Map<string, Hit[]>();
  for (const h of hits) (m.get(h.path) ?? m.set(h.path, []).get(h.path)!).push(h);
  return [...m];
}
