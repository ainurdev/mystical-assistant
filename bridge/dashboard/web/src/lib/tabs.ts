/* Tab-strip bookkeeping for the EDITOR: which tab to focus when the open one
   goes away, and how a rename or delete moves paths through the strip. Kept
   pure and out of the component so it can be checked — see tabs.check.ts. */

// `from` itself and everything under it: renaming `a/b` also moves `a/b/c.ts`.
export function underPath(from: string, p: string): boolean {
  return p === from || p.startsWith(`${from}/`);
}

/* Rewrite the strip for a rename (`to` set) or a delete (`to` null). Order is
   preserved, so a renamed file keeps its place. */
export function remapPaths(tabs: string[], from: string, to: string | null): string[] {
  return tabs.flatMap((p) =>
    !underPath(from, p) ? [p] : to === null ? [] : [to + p.slice(from.length)]);
}

/* What each tab is called: the bare file name, plus its parent directory when
   another open tab shares that name — a repo full of SKILL.md, index.ts and
   __init__.py is unreadable otherwise.

   ponytail: one level of parent only, so a/x/f.ts and b/x/f.ts still both read
   x/f.ts. Walk further up (VS Code's rule) if that shows up in practice. */
export function tabLabels(tabs: string[]): string[] {
  const name = (p: string) => p.split("/").pop() ?? p;
  const names = tabs.map(name);
  const dupes = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  return tabs.map((p, i) => (dupes.has(names[i]) ? p.split("/").slice(-2).join("/") : names[i]));
}

/* VS Code's preview tab: a single click in the explorer reuses one slot instead
   of piling up tabs. `peek` is the path currently sitting in that slot — the new
   path takes its place, appends when there is no slot yet, and changes nothing
   when the file already has a real tab of its own. */
export function previewTabs(tabs: string[], peek: string | null, path: string): string[] {
  if (tabs.includes(path)) return tabs;
  const i = peek === null ? -1 : tabs.indexOf(peek);
  if (i < 0) return [...tabs, path];
  const out = [...tabs];
  out[i] = path;
  return out;
}

/* The tab to focus once `leaving` is gone, given the tabs that survive: its
   nearest right-hand neighbour, else the new last tab, else nothing — VS Code's
   rule. `rest` is passed in rather than derived because a directory delete can
   take several tabs at once. */
export function nextFocus(tabs: string[], leaving: string, rest: string[]): string | null {
  if (rest.length === 0) return null;
  const i = tabs.indexOf(leaving);
  if (i < 0) return rest[0];
  return rest.find((p) => tabs.indexOf(p) > i) ?? rest[rest.length - 1];
}
