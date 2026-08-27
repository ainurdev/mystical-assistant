import type { Turn } from "../chat";

/** A session as markdown you can paste into an issue, a PR, or another chat.
 *
 *  Prose and results only — tool calls become a one-line trace rather than their
 *  full input/output. The point is a readable record of what was asked and what
 *  came back; a hundred lines of Read output helps nobody reading it later.
 */
export function chatToMarkdown(turns: Turn[], title?: string): string {
  const out: string[] = [];
  if (title) out.push(`# ${title}`, "");
  for (const t of turns) {
    if (t.prompt.trim()) out.push(`## ${t.prompt.trim()}`, "");
    const tools: string[] = [];
    for (const e of t.events) {
      if (e.type === "text" && e.text.trim()) {
        if (tools.length) { out.push(toolLine(tools), ""); tools.length = 0; }
        out.push(e.text.trim(), "");
      } else if (e.type === "tool") {
        tools.push(e.name);
      } else if (e.type === "result" && (e.result ?? "").trim()) {
        if (tools.length) { out.push(toolLine(tools), ""); tools.length = 0; }
        out.push(e.result.trim(), "");
      }
    }
    if (tools.length) out.push(toolLine(tools), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** `_used Read ×3 · Bash · Edit_` — enough to see the shape of the work. */
function toolLine(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return `_used ${parts.join(" · ")}_`;
}
