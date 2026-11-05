/** A ticket set as columns for the TICKETS card's graph: a ticket's column is 1 + its
 *  longest blocker chain, rows go by number inside a column, and MERGE is a last column
 *  of its own, fed by every ticket nothing else waits on. A blocker the set doesn't
 *  have is ignored (a deleted ticket file) rather than looped on; a cycle can't reach
 *  here, since the bridge refuses to build one. */
export type DagIn = { n: string; blockedBy: string[] };
export type DagNode = { n: string; col: number; row: number };

export function dagLayout(tickets: DagIn[]): { nodes: DagNode[]; edges: { from: string; to: string }[]; cols: number } {
  const by = new Map(tickets.map((t) => [t.n, t]));
  const colOf = new Map<string, number>();
  const col = (n: string, seen: string[] = []): number => {
    const known = colOf.get(n);
    if (known !== undefined) return known;
    const ups = (by.get(n)?.blockedBy ?? []).filter((b) => by.has(b) && !seen.includes(b));
    const c = ups.length ? 1 + Math.max(...ups.map((b) => col(b, [...seen, n]))) : 0;
    colOf.set(n, c);
    return c;
  };
  const rows: Record<number, number> = {};
  const nodes: DagNode[] = [...tickets].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)).map((t) => {
    const c = col(t.n);
    rows[c] = (rows[c] ?? -1) + 1;
    return { n: t.n, col: c, row: rows[c] };
  });
  const cols = nodes.length ? Math.max(...nodes.map((x) => x.col)) + 1 : 0;
  const edges = tickets.flatMap((t) => t.blockedBy.filter((b) => by.has(b)).map((b) => ({ from: b, to: t.n })));
  const waited = new Set(edges.map((e) => e.from));
  for (const x of nodes) if (!waited.has(x.n)) edges.push({ from: x.n, to: "MERGE" });
  nodes.push({ n: "MERGE", col: cols, row: 0 });
  return { nodes, edges, cols: cols + 1 };
}
