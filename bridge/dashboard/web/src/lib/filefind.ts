/** FILES' find field (⌘P): which paths of the tree hold what you typed.
 *  A plain case-insensitive substring, not a fuzzy matcher: "table" finds what
 *  says table, and the order explains itself — a match in the file's name before
 *  a match only in its folders, then the shortest name (the closest to what you
 *  typed: table.tsx, data-table.tsx, then table-paging-light-chromium.png), a
 *  name that starts with it, the shallower path, then the path. Git-ignored
 *  paths (`last`: scratch and build output, dimmed in the tree) go after the
 *  rest. `total` counts every match; `limit` only cuts
 *  what the list draws. */
export interface FileHit {
  path: string;
  name: string;
  dir: string;   // "" at the repo root
  at: number;    // where the match starts in `name`; -1 when only the folders matched
}

export function findFiles(paths: string[], query: string, limit = 60,
                          last: (path: string) => boolean = () => false): { hits: FileHit[]; total: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], total: 0 };
  const found: (FileHit & { tier: number })[] = [];
  for (const path of paths) {
    const cut = path.lastIndexOf("/");
    const name = path.slice(cut + 1);
    const at = name.toLowerCase().indexOf(q);
    if (at < 0 && !path.toLowerCase().includes(q)) continue;
    found.push({ path, name, dir: cut < 0 ? "" : path.slice(0, cut), at, tier: (at < 0 ? 1 : 0) + (last(path) ? 2 : 0) });
  }
  found.sort((a, b) => a.tier - b.tier || a.name.length - b.name.length
    || (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || a.path.split("/").length - b.path.split("/").length
    || a.path.localeCompare(b.path));
  return { hits: found.slice(0, limit).map(({ tier: _t, ...h }) => h), total: found.length };
}
