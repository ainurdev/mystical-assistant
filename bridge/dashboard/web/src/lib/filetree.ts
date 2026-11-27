// The file tree EditorTab and FILES both draw, apart from the editor so FILES
// (in the entry script) doesn't pull the editor in.
import { cmpTreePath } from "./pathsort";

export interface TreeRow {
  key: string;
  dir: boolean;
  depth: number;
  name: string;
  path: string;
}

/* Flatten a sorted path list into a collapsible directory tree (dirs before
   their files, honoring the collapsed set). */
export function buildRows(paths: string[], collapsed: Set<string>): TreeRow[] {
  const sorted = [...paths].sort(cmpTreePath);
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  for (const path of sorted) {
    const parts = path.split("/");
    let prefix = "";
    let hidden = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (!hidden && !seen.has(p)) {
        seen.add(p);
        rows.push({ key: `d:${p}`, dir: true, depth: i, name: parts[i], path: p });
      }
      if (collapsed.has(p)) hidden = true;
      prefix = p;
    }
    if (!hidden) rows.push({ key: `f:${path}`, dir: false, depth: parts.length - 1, name: parts[parts.length - 1] ?? path, path });
  }
  return rows;
}

/* Every directory that appears in the path list — the collapse-all set. */
export function dirsOf(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      out.add(prefix);
    }
  }
  return [...out];
}
