// Run: node bridge/dashboard/web/src/lib/agentteam.check.ts
import { sayTo, span, stopAsk, treeRows, type TeamAgent } from "./agentteam.ts";

const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`FAIL: ${what} — got ${JSON.stringify(got)}`);
  console.log(`ok - ${what}`);
};
const a = (id: string, parent: string, status: TeamAgent["status"]): TeamAgent => ({ id, name: id, parent, depth: 1, status, started: 0, updated: 0, model: null, tools: 0, now: "" });
const agents = [a("lead", "main", "waiting"), a("k1", "lead", "running"), a("d1", "lead", "done"), a("d2", "lead", "done"), a("d3", "lead", "done"), a("old", "main", "done")];
const names = (rows: ReturnType<typeof treeRows>) => rows.map((r) => (r.kind === "agent" ? `${"  ".repeat(r.depth - 1)}${r.agent.id}` : `${"  ".repeat(r.depth - 1)}[${r.label}]`));
const all = () => true;
eq(names(treeRows(agents, new Set(), new Set(), all)), ["lead", "  k1", "  [3 done]", "old"], "working first, finished ones folded under their lead");
eq(names(treeRows(agents, new Set(), new Set(["lead"]), all)), ["lead", "  k1", "  d1", "  d2", "  d3", "old"], "a fold opens");
eq(names(treeRows(agents, new Set(["lead"]), new Set(), all)), ["lead", "old"], "a lead shuts");
eq(names(treeRows(agents, new Set(), new Set(), (x) => x.status === "running")), ["lead", "  k1"], "a filter keeps the path to what it shows");
const lead = treeRows(agents, new Set(), new Set(), all)[0];
eq(lead.kind === "agent" && [lead.kids, lead.working], [4, 1], "a lead counts its helpers and the ones working");
eq(span(0, 59), "59s", "seconds"); eq(span(0, 3900), "1h 05m", "hours");
eq(sayTo(null, "hi"), "hi", "to the main agent, just the words");
eq(sayTo({ id: "agent-ab12", name: "Dare lines" }, "hi").includes('"Dare lines" (id ab12), and to nobody else:\n\nhi'), true, "to one agent, by name and id");
eq(stopAsk({ id: "agent-ab12", name: "Lead", group: true }).includes("every agent it started"), true, "stopping a lead takes its helpers");
