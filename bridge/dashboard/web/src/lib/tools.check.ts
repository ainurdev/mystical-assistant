// Run: node bridge/dashboard/web/src/lib/tools.check.ts
import { cmdAbstract, cmdKind, hostOf, mcpParts, toolAccent, toolKind } from "./tools.ts";

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

const abs = (c: string) => cmdAbstract(c);
ok(abs("git add a.ts b.ts c.ts") === "stage 3 files", `git add: ${abs("git add a.ts b.ts c.ts")}`);
ok(abs("git diff bridge/dashboard/web/src/components/Composer.tsx") === "diff Composer.tsx", "a diff names the file, not the path");
ok(abs("git branch -d feat/session-worktree-mirror && git worktree prune -v") === "delete branch feat/session-worktree-mirror +1 more",
   `a chain owns up to the rest: ${abs("git branch -d feat/x && git worktree prune")}`);
ok(abs("sed -n 1755,1772p bridge/runner.py") === "read lines 1755–1772 of runner.py", `sed range: ${abs("sed -n 1755,1772p bridge/runner.py")}`);
ok(abs('grep -rn "isdir(cwd)" bridge/runner.py bridge/sessions.py') === "search “isdir(cwd)” in 2 files", `grep: ${abs('grep -rn "isdir(cwd)" a.py b.py')}`);
ok(abs("python3 -m pytest tests/ -q") === "run the tests", "pytest through the interpreter still reads as a test run");
ok(abs("mystical status 2>&1 | head -20") === "mystical status", "a pipe into head is formatting, not another command");
ok(abs("python3 - <<'PY'\nimport os\nPY") === "run a python snippet", `heredoc: ${abs("python3 - <<'PY'")}`);
ok(abs("./node_modules/.bin/vite build") === "build the app", "a binary out of node_modules is still vite");
ok(abs("for d in /proc/*; do echo $d; done") === "", "a shell loop has no honest summary, so the row keeps the command");
