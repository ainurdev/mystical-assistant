// The Rivendell deck's order: the todolist's tasks first (Rivendell's order is
// its priority), then the rest as the tab always listed them (needs, mine,
// team). A task skipped in the last 24h goes to the back — time-boxed so a
// skip never buries a task for good.
import { groupTasks } from "./rivendelltasks.ts";

const SKIP_MS = 24 * 3_600_000;

export function deck<T extends Parameters<typeof groupTasks>[0][number] & { id: string }>(
  open: T[], nextIds: string[], skipped: Record<string, number>, now: number,
): T[] {
  const by = new Map(open.map((t) => [t.id, t]));
  const first = [...new Set(nextIds)].flatMap((id) => by.get(id) ?? []);
  const g = groupTasks(open);
  const rest = [...g.needs, ...g.mine, ...g.team].filter((t) => !first.includes(t));
  const all = [...first, ...rest];
  const skip = (t: T) => now - (skipped[t.id] ?? -Infinity) < SKIP_MS;
  return [...all.filter((t) => !skip(t)), ...all.filter(skip)];
}

/** Markdown as plain words, cut at a word with "…" past `n` characters. */
export function excerpt(md: string, n = 160): string {
  const s = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+>]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 0 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}
