// The Rivendell deck's order: the todolist's tasks first (Rivendell's order is
// its priority), then the rest as the tab always listed them (needs, mine,
// team). A task skipped in the last 24h goes to the back — time-boxed so a
// skip never buries a task for good.
import { groupTasks } from "./rivendelltasks.ts";

export const SKIP_MS = 24 * 3_600_000;

/** A project's stored skips ({sig: the next-up order they were made under, at: id -> when}),
 *  as the ones still in force: none once the todolist's order has changed, none older than a day. */
export function liveSkips(stored: { sig: string; at: Record<string, number> } | null, sig: string, now: number): Record<string, number> {
  if (!stored || stored.sig !== sig) return {};
  return Object.fromEntries(Object.entries(stored.at).filter(([, at]) => now - at < SKIP_MS));
}

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

