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
