/* SETTINGS ▸ Projects (ProjectsSettings): which projects the list shows, and
   under which folder. Pure, so projectlist.check.ts can pin it. */

/** Owning folder of a repo path: "ainurhq/efas/app" → "ainurhq/efas",
 *  "aligned" → "" (top level). */
export function parentOf(rel: string): string {
  const clean = rel.replace(/^\/+|\/+$/g, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? "" : clean.slice(0, i);
}

export type Show = "all" | "shown" | "hidden";

export interface ListRow { rel: string; name: string; remote: string; hidden: boolean }

/** A query matches the name, the path or the GitHub remote, in any case — so
 *  "efasone" finds Efas App by its remote and "rijschool" a whole folder. */
export function matches(r: ListRow, q: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || [r.name, r.rel, r.remote].some((s) => s.toLowerCase().includes(n));
}

/** The rows a query and a filter leave. The counts follow the query, not the
 *  filter, so each filter button says what it would show. */
export function filterRows<T extends ListRow>(rows: T[], q: string, show: Show) {
  const hits = rows.filter((r) => matches(r, q));
  const hidden = hits.filter((r) => r.hidden).length;
  return {
    rows: show === "all" ? hits : hits.filter((r) => r.hidden === (show === "hidden")),
    counts: { all: hits.length, shown: hits.length - hidden, hidden },
  };
}

/** One section per owning folder, in path order, so a folder always comes
 *  before its sub-folders, and top-level repos ("~") last. Placing a section by
 *  its first member instead put ainurhq/unideck-mono above ainurhq once a filter
 *  left only yggdrasil in ainurhq. Rows keep the order they came in. */
export function folders<T extends { rel: string }>(rows: T[]): { parent: string; rows: T[] }[] {
  const at = new Map<string, T[]>();
  for (const r of rows) {
    const p = parentOf(r.rel);
    at.set(p, [...(at.get(p) ?? []), r]);
  }
  return [...at].sort(([a], [b]) => Number(a === "") - Number(b === "") || a.localeCompare(b)).map(([parent, rs]) => ({ parent, rows: rs }));
}

/** Shift-click: every project from the anchor to the one clicked, in the
 *  order the list draws them. An anchor no longer in the list picks just the
 *  one clicked. */
export function span(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from), b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
