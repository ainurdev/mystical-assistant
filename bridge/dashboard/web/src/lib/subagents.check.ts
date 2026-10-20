// Run: node bridge/dashboard/web/src/lib/subagents.check.ts
// The AGENTS modal's roster: who is working first, the finished ones newest
// first, a workflow's agents under their run, and a filter that counts what it
// kept. Plus how a row's spans and meta line read.
import type { AgentInfo, WorkflowInfo } from "../api.ts";
import { agentMeta, fmtClock, fmtSpan, rosterSections } from "./subagents.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const agent = (id: string, started: number, status: "running" | "done" = "done", over: Partial<AgentInfo> = {}): AgentInfo => ({
  agent_id: id, agent_type: "general-purpose", description: `task ${id}`, tool_use_id: `t-${id}`, spawn_depth: 1,
  status, started_at: started, updated_at: started + 60, model: "sonnet", tools: 3, ...over,
});

// --- sections -------------------------------------------------------------------
const agents = [agent("a", 100), agent("b", 200, "running"), agent("c", 300), agent("d", 400, "running")];
const s = rosterSections(agents, [], "");
eq(s.map((x) => x.name), ["Working", "Done"], "WORKING before DONE");
eq(s[0].items.map((i) => i.key), ["b", "d"], "the working ones in the order they started");
eq(s[1].items.map((i) => i.key), ["c", "a"], "the finished ones newest first");
eq(rosterSections(agents.filter((a) => a.status === "done"), [], "").map((x) => x.name), ["Done"],
  "an empty section is not drawn");

const wf: WorkflowInfo = { run_id: "wf_1", name: "hunt", status: "running", agent_count: 2, total_tokens: 0,
  total_tool_calls: 0, duration_ms: 0, summary: "", agents: [
    { agent_id: "w1", agent_type: "workflow-subagent", description: "scan", run_id: "wf_1", status: "running",
      started_at: 10, updated_at: 20, model: null, tools: 0 },
  ] };
const withWf = rosterSections(agents, [wf], "");
eq(withWf.map((x) => x.name), ["Working", "Done", "Workflow · hunt"], "a workflow's agents keep their run");
eq(withWf[2].items[0].key, "wf_1::w1", "a workflow agent's key names its run (agent_activity reads its dir)");

// --- filter ---------------------------------------------------------------------
const f = rosterSections([...agents, agent("e", 500, "done", { description: "Re-review Task 4", agent_type: "Explore" })], [], "re-review");
eq(f.map((x) => [x.name, x.items.length, x.total]), [["Done", 1, 3]], "a filter keeps matches and counts what it kept of how many");
eq(rosterSections(agents, [], "explore").length, 0, "nothing matches, nothing drawn");
eq(rosterSections([agent("x", 1, "done", { agent_type: "Explore" })], [], "EXPLORE")[0].items.length, 1,
  "the filter matches the type too, any case");

// --- rows -----------------------------------------------------------------------
eq(agentMeta(agent("a", 0)), "Sonnet · 3 tools", "general-purpose is the default: left off the meta line");
eq(agentMeta(agent("a", 0, "done", { agent_type: "feature-dev:code-reviewer", model: null, tools: 0 })),
  "code-reviewer", "a plugin agent by its own name; no model yet, no tools yet: neither printed");
eq([fmtSpan(42), fmtSpan(14 * 60 + 2), fmtSpan(72 * 60)], ["42s", "14m", "1h 12m"], "spans");
eq(fmtClock(7 * 60 + 8), "7:08", "a running agent's clock");

console.log("all subagents checks passed");
