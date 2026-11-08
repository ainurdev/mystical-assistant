// A docs page cut into Markdown and live views (bridge/project_docs.py). Pure, for docparts.check.ts.
// The same file is in both apps.

import type { DataEv } from "./dataview";

export type Part = { md: string } | { view: DataEv };

const VIEW = /```view[ \t]*\n([\s\S]*?)\n```/g;

export function docParts(text: string): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(VIEW)) {
    const i = m.index ?? 0;
    if (text.slice(at, i).trim()) out.push({ md: text.slice(at, i) });
    try {
      out.push({ view: JSON.parse(m[1]) as DataEv });
    } catch {
      out.push({ md: m[0] });      // as written: better than losing it
    }
    at = i + m[0].length;
  }
  if (text.slice(at).trim()) out.push({ md: text.slice(at) });
  return out;
}

export type DocPage = { id: string; title: string; group: string; summary: string; sources: string[]; written: boolean; written_at?: number; changed: string[] };

/** Pages in their groups, keeping the order the outline gave them. */
export function byGroup(pages: DocPage[]): { group: string; pages: DocPage[] }[] {
  const out: { group: string; pages: DocPage[] }[] = [];
  for (const p of pages) {
    const hit = out.find((g) => g.group === p.group);
    if (hit) hit.pages.push(p);
    else out.push({ group: p.group, pages: [p] });
  }
  return out;
}

export const outlinePrompt = (where: string) =>
  `Read this project well enough to document it: its structure, main flows and the decisions behind them. Then use find_tools to get docs_outline, and call it with location "${where}" and a table of contents: pages a new developer or an agent would really use, in groups, each with what it covers and the files it's about. Fewer good pages beat many thin ones. Don't write any pages yet: I'll look at the contents in the Docs tab first.`;

export const writePrompt = (ids: string[]) =>
  `Write ${ids.length === 1 ? `the docs page "${ids[0]}"` : `these docs pages: ${ids.join(", ")}`} with doc_page (find_tools has it, and read_docs shows the outline). Read the real code first and don't guess: say which file things live in, and mark anything you're unsure of. Where something has a shape, use a fenced \`\`\`view block holding the same JSON as show_data's arguments: a flowchart for how a request moves, a table for options or settings, a chart for numbers. They draw live in the Docs tab.`;
