// Run: node bridge/dashboard/web/src/lib/tools.check.ts
import { cmdKind, hostOf, mcpParts, toolAccent, toolKind } from "./tools.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(toolKind("Bash") === "bash", "Bash is a terminal");
ok(toolKind("Read") === "read" && toolKind("Edit") === "write", "reads and writes split");
ok(toolKind("Grep") === "search" && toolKind("WebFetch") === "web", "lookups and web split");
ok(toolKind("Task") === "agent" && toolKind("TodoWrite") === "plan", "agent and plan kinds");
ok(toolKind("mcp__github__list_issues") === "mcp", "any mcp__ tool is an MCP call");
ok(toolKind("SomethingNew") === "plain", "an unknown tool falls back to the plain chip");

ok(toolAccent("Read") !== toolAccent("Write"), "read and write never share an accent");
ok(!!toolAccent("SomethingNew"), "every kind has an accent");

const p = mcpParts("mcp__github__list_issues");
ok(p.server === "github" && p.tool === "list issues", `mcp name splits: ${JSON.stringify(p)}`);
const p2 = mcpParts("mcp__plugin_cloudflare__d1_database_query");
ok(p2.server === "plugin_cloudflare" && p2.tool === "d1 database query", "server names keep their underscores");

ok(hostOf("https://example.com/a/b?q=1") === "example.com", "url yields its host");
ok(hostOf("how do I center a div") === "", "a search query is not a url");

ok(cmdKind("git status --short | head") === "git", "the first binary wins, not the pipe");
ok(cmdKind("cd bridge/dashboard/web && npm run build") === "pkg", "cd's argument is not the command");
ok(cmdKind("timeout 30 python3 script.py") === "run", "timeout and its seconds are scaffolding");
ok(cmdKind("python3 -m pytest tests/ -q") === "test", "a test run reads as a test, not python");
ok(cmdKind("grep -rn foo src | head -20") === "search", "grep is a search even when it feeds head");
ok(cmdKind("/usr/bin/docker ps") === "docker", "an absolute path resolves to its basename");
ok(cmdKind("mystical restart | grep ok") === "shell", "an unknown binary falls back to the shell icon");
ok(cmdKind("") === "shell", "an empty command still has an icon");
