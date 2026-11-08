// What a refinement would change in a task, word by word (components/WorkPanel). Longest common
// subsequence: a suggestion is short, and past LIMIT words it's a rewrite, so it says just that.

export type Part = { kind: "same" | "add" | "del"; text: string };

const LIMIT = 800;
const words = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

export function wordDiff(before: string, after: string): Part[] {
  const a = words(before), b = words(after);
  if (before === after) return after ? [{ kind: "same", text: after }] : [];
  if (a.length * b.length > LIMIT * LIMIT) return [...(before ? [{ kind: "del" as const, text: before }] : []), ...(after ? [{ kind: "add" as const, text: after }] : [])];
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: Part[] = [];
  const put = (kind: Part["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text; else out.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { put("same", a[i]); i++; j++; }
    else if (j < b.length && (i >= a.length || t[i][j + 1] >= t[i + 1][j])) put("add", b[j++]);
    else put("del", a[i++]);
  }
  return out;
}
