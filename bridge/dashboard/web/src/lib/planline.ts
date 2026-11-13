// A plan change as the chat says it (components/PlanLine; bridge/chatplan.py changes). Same file in both apps.

export type PlanChange = {
  kind: "added" | "removed" | "renamed" | "done" | "started" | "skipped" | "reopened" | "substeps" | "edited";
  n: number | null; id: string; title: string; was?: string; done?: number; of?: number;
};
export type PlanEv = { type: "plan"; first: boolean; done: number; total: number; steps: string[]; changes: PlanChange[]; more: number };

export function planHead(ev: PlanEv): string {
  return ev.first ? `Made a plan: ${ev.total} step${ev.total === 1 ? "" : "s"}` : `Plan · ${ev.done} of ${ev.total} done`;
}

export function planSay(c: PlanChange): string {
  const n = c.n ?? "";
  switch (c.kind) {
    case "done": return `Step ${n} done: ${c.title}`;
    case "started": return `Started step ${n}: ${c.title}`;
    case "skipped": return `Skipped step ${n}: ${c.title}`;
    case "reopened": return `Step ${n} is open again: ${c.title}`;
    case "added": return `Added step ${n}: ${c.title}`;
    case "removed": return `Dropped a step: ${c.title}`;
    case "renamed": return `Step ${n} now reads: ${c.title}`;
    case "substeps": return `Step ${n}: ${c.done} of ${c.of} sub-steps done`;
    case "edited": return `Step ${n}'s description changed: ${c.title}`;
  }
}
