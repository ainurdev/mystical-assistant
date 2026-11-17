/** A ticket set as columns for the ticket map: a ticket's column is 1 + its longest
 *  blocker chain (with every ready ticket starting at once, a column is a wave that runs
 *  together), rows go by the blockers' average row inside a column, and MERGE is a last column
 *  of its own, fed by every ticket nothing else waits on. A blocker the set doesn't
 *  have is ignored (a deleted ticket file) rather than looped on; a cycle can't reach
 *  here, since the bridge refuses to build one. */
/** What a ticket's row shows, from its status in set.json and its session's live state.
 *  idle: its turn ended without finishing and nothing will start another (the bridge's
 *  `stalled`). An ask wins over idle: answering it is what carries the ticket on.
 *  you: a ticket of yours (ready-for-human), waiting for Go. */
export type Kind = "run" | "ask" | "idle" | "q" | "done" | "fix" | "you";
const ASKING = ["awaiting", "asking", "credits"];
export const kindOf = (t: { status: string; stalled?: boolean }, state?: string): Kind =>
  t.status === "done" ? "done" : t.status === "fix" ? "fix" : t.status === "yours" ? "you"
    : t.status === "running" ? (state && ASKING.includes(state) ? "ask" : t.stalled ? "idle" : "run") : "q";

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
  // Column 0 goes by number; every later column by its blockers' average row (ties by
  // number), which keeps most edges from crossing.
  const rowOf = new Map<string, number>();
  const byNum = [...tickets].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  const cols = byNum.length ? Math.max(...byNum.map((t) => col(t.n))) + 1 : 0;
  const nodes: DagNode[] = [];
  for (let c = 0; c < cols; c++) {
    const here = byNum.filter((t) => col(t.n) === c);
    const mean = (t: DagIn) => {
      const rs = t.blockedBy.filter((b) => rowOf.has(b)).map((b) => rowOf.get(b)!);
      return rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : 0;
    };
    if (c > 0) here.sort((a, b) => mean(a) - mean(b));   // stable: equal means keep number order
    here.forEach((t, i) => { rowOf.set(t.n, i); nodes.push({ n: t.n, col: c, row: i }); });
  }
  const edges = tickets.flatMap((t) => t.blockedBy.filter((b) => by.has(b)).map((b) => ({ from: b, to: t.n })));
  const waited = new Set(edges.map((e) => e.from));
  for (const x of nodes) if (!waited.has(x.n)) edges.push({ from: x.n, to: "MERGE" });
  nodes.push({ n: "MERGE", col: cols, row: 0 });
  return { nodes, edges, cols: cols + 1 };
}
