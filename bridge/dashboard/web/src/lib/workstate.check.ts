// Run: node bridge/dashboard/web/src/lib/workstate.check.ts
import { workState } from "./workstate.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const line = (s: ReturnType<typeof workState>) => `${s.tag}|${s.detail}|${s.more}|${s.since}`;

const tool = (id: string, name: string, summary: string, at: number, agent?: { type?: string; title?: string }) =>
  ({ type: "tool", id, name, summary, at, agent });
const done = (id: string, at: number) => ({ type: "tool_done", id, at });

// Boot wins: nothing has spoken yet, so the wait is what's happening.
ok(line(workState([], "starting Claude", 100)) === "starting Claude||0|100", "boot text, since the turn started");

// A running command reads as what it does, from the tool's own start.
{
  const s = workState([tool("a", "Bash", "python3 -m pytest tests/ -q", 105)], null, 100);
  ok(line(s) === "BASH|run the tests|0|105", `running bash: ${line(s)}`);
}

// A command nothing here can phrase falls back to the command itself.
{
  const s = workState([tool("a", "Bash", "./weird-thing --flag", 105)], null, 100);
  ok(s.detail === "./weird-thing --flag", `bash fallback: ${s.detail}`);
}

// Parallel reads: the newest one is named, the rest are counted.
{
  const evs = [
    tool("a", "Read", "/r/src/lib/theme.ts", 101),
    tool("b", "Read", "/r/src/lib/tools.ts", 102),
    tool("c", "Grep", "PHRASES", 103),
    done("a", 104),
  ];
  const s = workState(evs, null, 100);
  ok(line(s) === "GREP|PHRASES|1|103", `newest open + count: ${line(s)}`);
}

// A file tool names the file, not the path.
ok(workState([tool("a", "Edit", "/r/src/App.tsx", 101)], null, 100).detail === "App.tsx", "edit shows basename");

// An agent reads as who was sent and what for.
{
  const s = workState([tool("a", "Agent", "long brief…", 101, { type: "Explore", title: "find the indicator" })], null, 100);
  ok(line(s) === "AGENT|Explore · find the indicator|0|101", `agent: ${line(s)}`);
}

// MCP: the server is the tag, the tool is the detail — not its raw arguments.
{
  const s = workState([tool("a", "mcp__playwright__browser_take_screenshot", "fullPage=true", 101)], null, 100);
  ok(line(s) === "PLAYWRIGHT|browser take screenshot|0|101", `mcp: ${line(s)}`);
}

// Nothing open: the model is thinking, since the last thing landed.
{
  const evs = [tool("a", "Bash", "ls", 101), done("a", 107)];
  ok(line(workState(evs, null, 100)) === "THINKING||0|107", "thinking since the last result");
}

// No events yet and no boot text: thinking since the turn started.
ok(line(workState([], null, 100)) === "THINKING||0|100", "thinking from the start");
