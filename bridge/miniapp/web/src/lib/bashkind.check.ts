// Run: node --experimental-strip-types --no-warnings src/lib/bashkind.check.ts
import { bashHead, bashKind, bashLine, parseTests, testWords } from "./bashkind.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const is = (cmd: string, want: string) => ok(bashKind(cmd) === want, `${cmd} -> ${want} (got ${bashKind(cmd)})`);

is("python3 -m pytest tests/ -q", "tests");
is("cd bridge/miniapp/web && ./node_modules/.bin/vitest run | tail -5", "tests");
is("FOO=1 npm test", "tests");
is("node --experimental-strip-types --no-warnings src/lib/said.check.ts", "tests");
is("npm run test:unit", "tests");
is("go test ./...", "tests");
is("./node_modules/.bin/tsc -b", "build");
is("./node_modules/.bin/vite build --outDir /tmp/x", "build");
is("npm run build 2>&1 | tail", "build");
is("make", "build");
is("npm ci", "install");
is("python3 -m pip install requests", "install");
is("git status --short", "git");
is("git log --oneline | grep fix", "git");
is("gh pr create --fill", "git");
is("rg foo src", "search");
is("find . -name '*.ts' | head", "search");
is("ls -la", "read");
is("sed -n 1,20p x.py", "read");
is("sed -i s/a/b/ x.py", "other");
is("python3 scripts/x.py", "run");
is("./deploy.sh", "run");
is("npm run dev", "run");
is("curl -s http://x", "run");
is("mkdir -p a && touch a/b", "other");
is("rm x", "other");
// Quoted and piped words don't count.
is('echo "npm test"', "other");
is("grep pytest README.md", "search");
is("git commit -m 'run pytest and npm test'", "git");
is("cat <<EOF > f\npytest\nEOF", "read");
// The strongest wins.
is("npm i && npm test", "tests");
is("cd x && git pull && make", "build");

ok(bashHead("cd a && python3 x.py --y") === "python3 x.py", "head skips cd");
ok(bashHead("./run.sh a b") === "./run.sh a", "head is two words");

const t = (s: string) => JSON.stringify(parseTests(s));
ok(t("===== 2 failed, 1005 passed, 3 skipped in 19s =====") === '{"passed":1005,"failed":2,"skipped":3}', "pytest");
ok(t("1007 passed in 19.2s") === '{"passed":1007}', "pytest, all green");
ok(t("Test Suites: 1 failed, 2 passed, 3 total\nTests:       4 failed, 10 passed, 14 total") === '{"passed":10,"failed":4}', "jest: tests beat suites");
ok(t(" Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 9 passed (11)") === '{"passed":9,"failed":2}', "vitest");
ok(t("test result: ok. 10 passed; 0 failed; 1 ignored; 0 measured") === '{"passed":10,"failed":0,"skipped":1}', "cargo");
ok(t("12 passing (3s)\n1 failing") === '{"passed":12,"failed":1}', "mocha");
ok(t("ok - a\nok - b\nok - c") === '{"passed":3}', "line per result");
ok(t("--- FAIL: TestA (0.0s)\nok  \tpkg/x\t0.1s") === '{"passed":1,"failed":1}', "go");
ok(t("\x1b[32m5 passed\x1b[0m") === '{"passed":5}', "colours stripped");
ok(parseTests("nothing to see") === null, "no numbers, no result");
ok(parseTests(undefined) === null, "no output, no result");
ok(testWords({ failed: 2, passed: 5, skipped: 1 }) === "2 failed · 5 passed · 1 skipped", "words: failures first");
ok(testWords({ passed: 5, failed: 0 }) === "5 passed", "words: zero failed is left out");

const line = bashLine([
  { command: "pytest -q", output: "2 failed, 8 passed" },
  { command: "pytest -q", output: "10 passed" },
  { command: "git status" }, { command: "git add ." }, { command: "tsc -b" }, { command: "rm x" },
]);
ok(line === "2 test runs: 10 passed · 1 build · 2 git · 1 command", `line: ${line}`);
ok(bashLine([]) === "", "no commands, no line");
ok(bashLine([{ command: "pytest", output: "boom" }]) === "1 test run", "unread output leaves the count");
