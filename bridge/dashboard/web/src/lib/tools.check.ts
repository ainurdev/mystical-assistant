// Run: node bridge/dashboard/web/src/lib/tools.check.ts
import { cmdAbstract, cmdKind, hostOf, mcpParts, toolAccent, toolKind, toolTag } from "./tools.ts";

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
ok(abs("for d in /proc/*; do echo $d; done") === "", "a loop that only echoes has no honest summary, so the row keeps the command");

// A `cd` into the worktree and an `echo` banner are how a turn labels its own
// output; the row has to say what came after them, not what came before.
ok(cmdKind('cd /x/staging\necho "=== routes ==="\ngrep -rn foo app') === "search", "a banner does not become the row's icon");
ok(abs('cd /x/staging\necho "=== A.1 import routes ==="; grep -rn "import" routes/web.php') === "search “import” in web.php",
   `past cd and echo: ${abs('cd /x\necho "=== A ==="; grep -rn "import" routes/web.php')}`);
ok(abs("cd bridge/dashboard/web && npm run build") === "run the build script", `a cd is not "+1 more": ${abs("cd bridge/dashboard/web && npm run build")}`);
ok(abs('grep -rn "risk_estimate\\|residual" app') === "search “risk_estimate” in the tree", `a segment cut mid-quote keeps no escape: ${abs('grep -rn "a\\|b" app')}`);

// A loop or a conditional reads as its body's first command; the header is
// syntax, and the whole program counts once toward "+N more".
const loop = 'cd /x/mystical-assistant && for p in $(pgrep -f "bridge" | head -20); do ps -p $p; done';
ok(abs(loop) === "look at running processes" && cmdKind(loop) === "proc", `a loop is what its body does: ${abs(loop)}`);
ok(abs("for f in a.log b.log; do grep -c ERROR $f; wc -l $f; done") === "search “ERROR” in $f +1 more",
   `a second command in the body still counts: ${abs("for f in a.log b.log; do grep -c ERROR $f; wc -l $f; done")}`);
ok(abs("if [ -f x.lock ]; then cat x.lock; else echo none; fi") === "read x.lock", `a conditional reads as its then-branch: ${abs("if [ -f x.lock ]; then cat x.lock; else echo none; fi")}`);
ok(abs("until curl -sf 127.0.0.1:8790 | grep -q ok; do sleep 1; done") === "" && cmdKind("until curl -sf 127.0.0.1:8790 | grep -q ok; do sleep 1; done") === "shell",
   "a loop's test is not its work, even past a pipe");

// A cd is scaffolding until it is all the line has to say — alone, or in front
// of a loop with nothing to say. Then it leads, as the place it went.
ok(abs("cd /home/me/projects/mystical-assistant") === "enter mystical-assistant", `a lone cd: ${abs("cd /home/me/projects/mystical-assistant")}`);
ok(cmdKind("cd bridge/dashboard/web") === "fs", "a lone cd wears the folder icon");
ok(abs("cd /x/web && for d in /proc/*; do echo $d; done") === "enter web +1 more", `a cd before an echo loop owns up to the loop, once: ${abs("cd /x/web && for d in /proc/*; do echo $d; done")}`);
ok(abs('cd "$(git rev-parse --show-toplevel)"') === "", "a cd into a substitution has no name to give, so the row keeps the line");

// The tag cell holds ten characters. A name that fits keeps its own; the ones
// that don't say the short word instead of losing their tail to an ellipsis.
ok(toolTag("Bash") === "BASH" && toolTag("ToolSearch") === "TOOLSEARCH", "a name that fits is the name");
ok(toolTag("ScheduleWakeup") === "WAKEUP" && toolTag("SendMessage") === "SEND", "the long ones are said short");
ok(toolTag("WebFetch") === "FETCH" && toolTag("TodoWrite") === "PLAN", "the labels the cards used to hardcode");
ok(toolTag("mcp__goals__UpdateGoal") === "GOALS", "an MCP row wears its server, not its tool");
ok(toolTag("mcp__railway-mcp-server__list_services") === "RAILWAY", `-mcp-server is what every server is: ${toolTag("mcp__railway-mcp-server__list_services")}`);
ok(toolTag("mcp__plugin_cloudflare_cloudflare-api__execute") === "CLOUDFLARE-API",
   `a plugin says its vendor twice: ${toolTag("mcp__plugin_cloudflare_cloudflare-api__execute")}`);
ok(toolTag("mcp__chrome-devtools__new_page") === "DEVTOOLS", "the one server nothing can be stripped from");
