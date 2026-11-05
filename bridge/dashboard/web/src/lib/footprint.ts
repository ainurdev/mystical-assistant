// FILES' hero: where this session's writes landed. A folder is the first two
// directory segments (apps/web), the top 4 by count get their own colour and the
// rest sum to "other". `recent` is the last 3 in the Set's order, which
// sessionEdits keeps as edit order (a rewrite moves to the end).

export type Footprint = {
  total: number;
  folders: { name: string; count: number }[];
  recent: { path: string; name: string; now: boolean }[];
};

export function footprint(edited: Set<string>, now: string | null, root: string): Footprint {
  const pre = root.endsWith("/") ? root : `${root}/`;
  const files = [...edited].map((p) => (p.startsWith(pre) ? p.slice(pre.length) : p));
  const by = new Map<string, number>();
  for (const f of files) {
    const dir = f.split("/").slice(0, -1).slice(0, 2).join("/") || "/";
    by.set(dir, (by.get(dir) ?? 0) + 1);
  }
  const sorted = [...by].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const folders = sorted.slice(0, 4);
  const rest = sorted.slice(4).reduce((s, f) => s + f.count, 0);
  if (rest) folders.push({ name: "other", count: rest });
  return {
    total: files.length,
    folders,
    recent: files.slice(-3).map((f) => ({ path: f, name: f.split("/").pop()!, now: f === now })),
  };
}
