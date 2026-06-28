import type { Capture } from "./protocol";

export interface ComposeItem {
  capture: Capture;
  note: string;
}
export interface ComposeInput {
  project: string | null;
  width: number;
  items: ComposeItem[];
  instruction: string;
}

function renderItem(item: ComposeItem, i: number): string {
  const c = item.capture;
  const lines: string[] = [];
  if (c.kind === "element") {
    const cls = c.classList.length ? ` class="${c.classList.join(" ")}"` : "";
    lines.push(`[${i + 1}] <${c.tag}${cls}> ${JSON.stringify(c.text)}`);
    if (c.mloc) lines.push(`    source: ${c.mloc}`);
    lines.push(`    selector: ${c.selector}`);
  } else {
    const near = c.nearestTag ? ` near <${c.nearestTag}>` : "";
    lines.push(`[${i + 1}] PIN${near} at (${Math.round(c.point.x)}, ${Math.round(c.point.y)})`);
    if (c.mloc) lines.push(`    source: ${c.mloc}`);
  }
  if (item.note.trim()) lines.push(`    note: ${item.note.trim()}`);
  return lines.join("\n");
}

export function composePrompt(input: ComposeInput): string {
  const where = input.project ? ` on ${input.project}` : "";
  const head = `Visual edit${where} at ${input.width}px. The user selected these in the running app:`;
  const body = input.items.map(renderItem).join("\n");
  return `${head}\n\n${body}\n\nInstruction: ${input.instruction.trim()}`;
}
