// What show_diff draws (bridge/data_views.py _diff is the contract), worked out for the screen:
// the line diff, its rows for each mode, the words that changed within a changed line, and
// which characters each comment covers. Pure, so codediff.check.ts can pin it. The same file
// is in both apps; components/DiffView draws it.

import { wordDiff } from "./worddiff.ts";

/** `at` is the range as the agent wrote it ("12", "2:20-3:4"); from/to are it worked out, 1-based, ends included. */
export type DiffComment = { side: "old" | "new"; from: [number, number]; to: [number, number]; text: string; at?: string };
export type DiffFile = { path: string; language: string; old: string | null; new: string; old_start: number; new_start: number; comments: DiffComment[] };
export type DiffMode = "unified" | "split" | "code";
export const DIFF_MODES: DiffMode[] = ["unified", "split", "code"];

export type Op = { kind: "same" | "del" | "add"; a: number; b: number };   // a, b: indexes into old, new (-1 where absent)

/** Beyond this many edits the middle of a diff is shown as all of it removed, then all of it
 *  added: Myers keeps a copy of its frontier per edit, and a diff that big is a rewrite. */
const MAX_EDITS = 2000;

/** Lines removed, added and kept, in order: Myers' greedy diff, after the common ends are cut. */
export function diffLines(a: string[], b: string[]): Op[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const head: Op[] = Array.from({ length: s }, (_, i) => ({ kind: "same", a: i, b: i }));
  const tail: Op[] = Array.from({ length: e }, (_, i) => ({ kind: "same", a: a.length - e + i, b: b.length - e + i }));
  const A = a.slice(s, a.length - e), B = b.slice(s, b.length - e);
  const N = A.length, M = B.length;
  const mid: Op[] = [];
  const all = () => {
    for (let i = 0; i < N; i++) mid.push({ kind: "del", a: s + i, b: -1 });
    for (let j = 0; j < M; j++) mid.push({ kind: "add", a: -1, b: s + j });
  };
  if (!N || !M) { all(); return [...head, ...mid, ...tail]; }
  const max = N + M, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDITS) && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) { all(); return [...head, ...mid, ...tail]; }
  // Walk back through the frontiers, from the end to the start.
  const at = (d: number, k: number) => trace[d][k + d + 1];
  let x = N, y = M;
  const back: Op[] = [];
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1)) ? k + 1 : k - 1;
    const px = at(d, prevK), py = px - prevK;
    while (x > px && y > py) { x--; y--; back.push({ kind: "same", a: s + x, b: s + y }); }
    if (x === px) back.push({ kind: "add", a: -1, b: s + (--y) });
    else back.push({ kind: "del", a: s + (--x), b: -1 });
  }
  while (x > 0 && y > 0) { x--; y--; back.push({ kind: "same", a: s + x, b: s + y }); }
  return [...head, ...back.reverse(), ...tail];
}

/** A run of changed characters within a line: [start, end), 0-based. */
export type Span = [number, number];

/** The words that changed between a removed line and the added line it became. Nothing when
 *  they share too little: then the whole line is the change, and marking words is noise. */
export function changedWords(before: string, after: string): { old: Span[]; new: Span[] } {
  const parts = wordDiff(before, after);
  const same = parts.filter((p) => p.kind === "same").reduce((t, p) => t + p.text.trim().length, 0);
  if (same < Math.min(before.trim().length, after.trim().length) * 0.4) return { old: [], new: [] };
  const out = { old: [] as Span[], new: [] as Span[] };
  let i = 0, j = 0;
  for (const p of parts) {
    if (p.kind === "same") { i += p.text.length; j += p.text.length; }
    else if (p.kind === "del") { if (p.text.trim()) out.old.push([i, i + p.text.length]); i += p.text.length; }
    else { if (p.text.trim()) out.new.push([j, j + p.text.length]); j += p.text.length; }
  }
  return out;
}

/** One line as drawn: its number on each side it's on, its text, and what changed in it. */
export type Line = { kind: "same" | "del" | "add"; o: number | null; n: number | null; text: string; words: Span[] };
export type Gap = { gap: number; id: string; lines: Line[] };    // unchanged lines folded away
export type Row = Line | Gap;
export type SplitRow = { left: Line | null; right: Line | null } | Gap;

const CONTEXT = 3;

/** The lines a file's diff shows, in order. `ops` from diffLines. */
export function lines(f: DiffFile, ops: Op[]): Line[] {
  const a = (f.old ?? "").split("\n"), b = f.new.split("\n");
  const out: Line[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "same") { out.push({ kind: "same", o: f.old_start + op.a, n: f.new_start + op.b, text: b[op.b], words: [] }); continue; }
    // A block of changes: pair the i-th removed line with the i-th added one for word marks.
    let j = i;
    while (j < ops.length && ops[j].kind !== "same") j++;
    const dels = ops.slice(i, j).filter((o) => o.kind === "del"), adds = ops.slice(i, j).filter((o) => o.kind === "add");
    const marks = dels.map((d, k) => (adds[k] ? changedWords(a[d.a], b[adds[k].b]) : null));
    dels.forEach((d, k) => out.push({ kind: "del", o: f.old_start + d.a, n: null, text: a[d.a], words: marks[k]?.old ?? [] }));
    adds.forEach((d, k) => out.push({ kind: "add", o: null, n: f.new_start + d.b, text: b[d.b], words: marks[k]?.new ?? [] }));
    i = j - 1;
  }
  return out;
}

/** Whether a comment touches a line, on the side it's on. */
const said = (cs: DiffComment[], l: Line) => cs.some((c) => {
  const no = c.side === "old" ? l.o : l.n;
  return no !== null && no >= c.from[0] && no <= c.to[0];
});

/** Fold long runs of unchanged lines, keeping CONTEXT on each side of a change and every line
 *  a comment is on: what the agent pointed at is never hidden. */
export function fold<T>(rows: T[], keep: (r: T) => boolean, id: string, wrapGap: (rs: T[], key: string) => T): T[] {
  const near = rows.map(keep);
  const show = rows.map((_, i) => near.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean));
  const out: T[] = [];
  for (let i = 0; i < rows.length;) {
    if (show[i]) { out.push(rows[i++]); continue; }
    let j = i;
    while (j < rows.length && !show[j]) j++;
    if (j - i <= 2) out.push(...rows.slice(i, j)); else out.push(wrapGap(rows.slice(i, j), `${id}:${i}`));
    i = j;
  }
  return out;
}

export function unifiedRows(f: DiffFile, ls: Line[]): Row[] {
  return fold<Row>(ls, (r) => "kind" in r && (r.kind !== "same" || said(f.comments, r)), f.path,
    (rs, key) => ({ gap: rs.length, id: key, lines: rs as Line[] }));
}

/** Side by side: unchanged lines face each other; in a block of changes, removed lines face
 *  the added ones in order, and the longer side faces blanks. */
export function splitRows(f: DiffFile, ls: Line[]): SplitRow[] {
  const rows: { left: Line | null; right: Line | null }[] = [];
  for (let i = 0; i < ls.length;) {
    if (ls[i].kind === "same") { rows.push({ left: ls[i], right: ls[i] }); i++; continue; }
    const dels: Line[] = [], adds: Line[] = [];
    while (i < ls.length && ls[i].kind !== "same") (ls[i].kind === "del" ? dels : adds).push(ls[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  type R = (typeof rows)[number];
  const keep = (r: R) => r.left?.kind !== "same" || said(f.comments, r.left) || said(f.comments, r.right!);
  return fold<SplitRow>(rows, (r) => "gap" in r ? false : keep(r), f.path, (rs, key) => ({ gap: rs.length, id: key, lines: (rs as R[]).map((r) => r.right!) }));
}

/** The characters of a line each comment covers: [start, end) and the comment's index. A whole
 *  empty line still counts, as a zero-width mark at its start. */
export function commentSpans(cs: DiffComment[], side: "old" | "new", no: number | null, len: number): { span: Span; i: number }[] {
  if (no === null) return [];
  const out: { span: Span; i: number }[] = [];
  cs.forEach((c, i) => {
    if (c.side !== side || no < c.from[0] || no > c.to[0]) return;
    const start = no === c.from[0] ? Math.max(0, c.from[1] - 1) : 0;
    const end = no === c.to[0] ? Math.min(len, c.to[1]) : len;
    out.push({ span: [Math.min(start, len), Math.max(Math.min(start, len), end)], i });
  });
  return out;
}

/** A line cut where any layer changes: syntax classes, changed words, comments. Each piece
 *  says which of them cover it, so the drawing is plain spans. */
export type Piece = { text: string; cls: string; changed: boolean; notes: number[] };
export function pieces(text: string, toks: { text: string; cls: string }[] | null, words: Span[], notes: { span: Span; i: number }[]): Piece[] {
  const cuts = new Set<number>([0, text.length]);
  const cls: { from: number; to: number; cls: string }[] = [];
  if (toks) {
    let at = 0;
    for (const t of toks) { if (t.cls) cls.push({ from: at, to: at + t.text.length, cls: t.cls }); cuts.add(at); at += t.text.length; cuts.add(at); }
  }
  for (const [a, b] of words) { cuts.add(a); cuts.add(b); }
  for (const { span: [a, b] } of notes) { cuts.add(a); cuts.add(b); }
  const at = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((x, y) => x - y);
  const out: Piece[] = [];
  for (let k = 0; k + 1 < at.length; k++) {
    const a = at[k], b = at[k + 1];
    if (a === b) continue;
    out.push({ text: text.slice(a, b), cls: cls.find((c) => c.from <= a && c.to >= b)?.cls ?? "",
      changed: words.some(([x, y]) => x <= a && y >= b), notes: notes.filter(({ span: [x, y] }) => x <= a && y >= b).map((n) => n.i) });
  }
  return out;
}

/** A whole text's tokens cut into one list per line, for pieces(). */
export function tokLines(toks: { text: string; cls: string }[] | null): { text: string; cls: string }[][] | null {
  if (!toks) return null;
  const out: { text: string; cls: string }[][] = [[]];
  for (const t of toks) {
    const parts = t.text.split("\n");
    parts.forEach((p, i) => { if (i) out.push([]); if (p) out[out.length - 1].push({ text: p, cls: t.cls }); });
  }
  return out;
}
