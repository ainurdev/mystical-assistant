/** `/` commands in the composer: a draft that is just `/word` opens the list,
 *  as the CLI's own input does. No caret tracking — on a phone you type the
 *  command first and its arguments after, and a space between them closes it.
 *  Same ranking as the dashboard's lib/slash.ts. */

import type { SlashCommand } from "./api";

/** The command word being typed, lowercased — or null when the draft isn't one. */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/") || /\s/.test(draft)) return null;
  return draft.slice(1).toLowerCase();
}

/** Commands worth offering for `q`, best first: the name starts with it, then
 *  the part after a plugin's `name:` does, then it appears anywhere. Ties are
 *  alphabetical, so the list reads the same every time you open it. */
export function rankCommands(cmds: SlashCommand[], q: string): SlashCommand[] {
  const scored: { c: SlashCommand; s: number }[] = [];
  for (const c of cmds) {
    const low = c.name.toLowerCase();
    const tail = low.slice(low.indexOf(":") + 1);
    const s = !q || low.startsWith(q) ? 0 : tail.startsWith(q) ? 1 : low.includes(q) ? 2 : -1;
    if (s >= 0) scored.push({ c, s });
  }
  scored.sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name));
  return scored.map((x) => x.c);
}

/** Is `q` already this command, typed out? The full name, or a plugin
 *  command's bare name (`/ponytail` resolves to `ponytail:ponytail`) — so Enter
 *  sends it rather than re-inserting what's there. */
export function isExact(c: SlashCommand, q: string): boolean {
  const low = c.name.toLowerCase();
  return low === q || low.slice(low.indexOf(":") + 1) === q;
}
