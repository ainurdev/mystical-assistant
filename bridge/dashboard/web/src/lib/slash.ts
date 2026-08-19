/** `/` commands in the prompt box: is the caret in a leading `/word`, and which
 *  of the bridge's command list match it. Picking one splices `/name ` over the
 *  word — `applyMention` from ./mention already does exactly that splice.
 *
 *  Only a `/` at index 0 opens the list: that is the only place the CLI reads
 *  one as a command, and a `/` anywhere else is a path.
 */

import type { SlashCommand } from "../api";
import type { Mention } from "./mention";

/** The leading command word the caret is in, if any — `{q, start: 0}` so it
 *  plugs into applyMention. A space ends the word; after it you're typing args. */
export function slashAt(text: string, caret: number): Mention | null {
  if (!text.startsWith("/") || caret < 1) return null;
  const q = text.slice(1, caret);
  if (/\s/.test(q)) return null;
  return { q: q.toLowerCase(), start: 0 };
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
