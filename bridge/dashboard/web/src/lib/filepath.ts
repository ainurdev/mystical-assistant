/** Does this inline-code span name a file in the repo?
 *
 *  Deliberately strict. The model writes plenty of code spans that are not paths
 *  — `npm run build`, `useState`, `--force` — and a wrong guess turns prose into
 *  a dead link. So: no whitespace, and either a directory separator or a known
 *  source extension. A trailing `:12` (or `:12:5`) is a line reference, which is
 *  how both Claude and every compiler print them.
 */

const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|css|scss|html|json|jsonc|ya?ml|toml|ini|cfg|env|md|mdx|txt|lock|svg|vue|svelte|astro|proto|graphql|gradle|dockerfile)$/i;

export interface FileRef {
  path: string;
  line?: number;
}

export function parseFileRef(raw: string): FileRef | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  // A URL is a link, not a file — and `https://x/y.ts` would otherwise match.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  const m = /^(.+?)(?::(\d+))?(?::\d+)?$/.exec(s);
  if (!m) return null;
  let path = m[1];
  const line = m[2] ? Number(m[2]) : undefined;
  // Leading ./ is noise; a bare / or ~ is an absolute path we can't resolve
  // against a project root, so leave those alone.
  if (path.startsWith("./")) path = path.slice(2);
  if (!path || path.startsWith("/") || path.startsWith("~")) return null;
  // Windows drive letters and flags are not repo paths.
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("-")) return null;
  const named = path.includes("/") || EXT.test(path);
  if (!named) return null;
  // A path is made of path characters. Anything else (parens, quotes, globs,
  // shell operators) means we're looking at a command, not a filename.
  if (!/^[\w.@/+-]+$/.test(path)) return null;
  // `a/b` alone is as likely to be prose or a fraction as a file; require either
  // an extension somewhere or more than one separator.
  if (!EXT.test(path) && path.split("/").length < 3) return null;
  return line ? { path, line } : { path };
}

/** Every tree entry the prose path could mean: the exact file, else everything
 *  ending in it (`src/App.tsx` for `bridge/dashboard/web/src/App.tsx`). */
export function fileRefCandidates(files: string[], path: string): string[] {
  if (files.includes(path)) return [path];
  return files.filter((f) => f.endsWith(`/${path}`));
}

/** Does this hint name that file? A hint is what a tool call was about, and for
 *  a Bash call that is the whole command line — `sed -n 1,80p a/b.ts`, a heredoc
 *  with the path buried in it. So the path is a substring of the hint, never the
 *  hint itself. The boundary check is what keeps `mega/lib/x.ts` from counting
 *  as a mention of `a/lib/x.ts`. */
function mentions(hint: string, file: string): boolean {
  for (let i = hint.indexOf(file); i >= 0; i = hint.indexOf(file, i + 1))
    if (!/[\w.-]/.test(hint[i - 1] ?? "")) return true;
  return false;
}

/** The parsed path, matched against the working tree it will be opened in.
 *
 *  A path in prose is a claim, not a fact: the model names files it has not
 *  created yet, and it writes them relative to whatever directory it was
 *  thinking in. Both land the editor on nothing. One candidate → that's it.
 *  Several (`App.tsx` lives in three packages here) → the one this session has
 *  actually been in, which is what the sentence meant: `hints` are its tool
 *  summaries, newest first. A hint that names several candidates (`diff a b`)
 *  settles nothing and the next one down gets to decide. Still undecidable →
 *  null, and the caller asks instead of opening a wrong buffer.
 */
export function resolveFileRef(files: string[], path: string, hints: string[] = []): string | null {
  const hits = fileRefCandidates(files, path);
  if (hits.length <= 1) return hits[0] ?? null;
  for (const h of hints) {
    const named = hits.filter((f) => mentions(h, f));
    if (named.length === 1) return named[0];
  }
  return null;
}

/** What a reader has to compare when picking between same-named files: each
 *  candidate's directory, minus the leading segments all of them share.
 *  `bridge/{dashboard,miniapp}/web/src/lib/x.ts` → `dashboard/web/src/lib` ·
 *  `miniapp/web/src/lib`. The filename is already on the chip they clicked. */
export function distinctDirs(paths: string[]): string[] {
  const segs = paths.map((p) => p.split("/").slice(0, -1));
  let i = 0;
  while (segs.every((s) => i < s.length - 1 && s[i] === segs[0][i])) i++;
  return segs.map((s) => s.slice(i).join("/") || ".");
}
