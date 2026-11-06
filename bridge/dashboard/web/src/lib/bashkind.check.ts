import assert from "node:assert/strict";
import { bashKind, bashSegments, testLine, testResult } from "./bashkind.ts";

const cases: [string, ReturnType<typeof bashKind>][] = [
  ["python3 -m pytest tests/ -q", "tests"],
  ["pytest", "tests"],
  ["cd web && npm test", "tests"],
  ["CI=1 FOO='a b' npm run test:unit -- --watch=false", "tests"],
  ["cd bridge/dashboard/web && node --experimental-strip-types --no-warnings src/lib/x.check.ts", "tests"],
  ["./node_modules/.bin/vitest run | tail -5", "tests"],
  ["npx jest src", "tests"],
  ["timeout 60 cargo test", "tests"],
  ["go test ./...", "tests"],
  ["uv run pytest -k foo", "tests"],
  ["bash -c 'cd x && pytest'", "tests"],
  ["make test", "tests"],
  ["(cd web && pnpm test)", "tests"],
  ["./node_modules/.bin/tsc -b", "build"],
  ["./node_modules/.bin/vite build --outDir /tmp/x", "build"],
  ["npm run build", "build"],
  ["cargo build --release", "build"],
  ["docker build .", "build"],
  ["make", "build"],
  ["git status", "git"],
  ["git -C /x log --oneline | head -5", "git"],
  ["git add . && git commit -m \"fix: pytest && grep\"", "git"],
  ["gh pr create --fill", "git"],
  ["git grep foo", "search"],
  ["grep -rn foo src", "search"],
  ["rg foo | wc -l", "search"],
  ["find . -name '*.py'", "search"],
  ["cat README.md", "read"],
  ["ls -la", "read"],
  ["sed -n 1,20p x.py", "read"],
  ["head -50 a && tail -5 b", "read"],
  ["npm install", "install"],
  ["npm ci", "install"],
  ["pip install requests", "install"],
  ["python3 -m pip install x", "install"],
  ["cargo add serde", "install"],
  ["node scripts/x.js", "run"],
  ["python3 tool.py --a", "run"],
  ["curl -s https://x.y | jq .a", "run"],
  ["./deploy.sh", "run"],
  ["npm run dev", "run"],
  ["rm -rf build", "other"],
  ["mkdir -p a && cp b c", "other"],
  ["cd x", "other"],
  ["echo hi", "other"],
  ["", "other"],
  ["frobnicate --now", "other"],
  ["cat > tests/x.py <<EOF\npytest\ngit push\nEOF", "other"],
  ["sed -i 's/a/b/' x", "other"],
  ["echo 'pytest && npm test'", "other"],
  ["grep 'pytest' file", "search"],
];
for (const [cmd, want] of cases) assert.equal(bashKind(cmd), want, cmd);

assert.deepEqual(bashSegments(`A=1 foo "x && y" && bar 'p|q' | baz`), [["A=1", "foo", "x && y"], ["bar", "p|q"], ["baz"]]);
assert.deepEqual(bashSegments("a 2>&1 | b"), [["a", "2>&1"], ["b"]]);

const res = (s: string) => testLine(testResult(s));
assert.equal(res("===== 3301 passed, 7 failed in 19.2s ====="), "3301 passed, 7 failed");
assert.equal(res("1007 passed in 19s"), "1007 passed");
assert.equal(res("===== 2 failed, 10 passed, 3 skipped, 1 error in 2s ====="), "10 passed, 3 failed, 3 skipped");
assert.equal(res("Test Suites: 1 failed, 1 total\nTests:       1 failed, 5 passed, 6 total\nTime: 2s"), "5 passed, 1 failed");
assert.equal(res("\u001b[32m Test Files  1 passed (1)\u001b[0m\n      Tests  4 passed (4)\n  Duration  1s"), "4 passed");
assert.equal(res("test result: ok. 5 passed; 0 failed; 1 ignored\ntest result: FAILED. 2 passed; 1 failed; 0 ignored"), "7 passed, 1 failed, 1 skipped");
assert.equal(res("# pass 3\n# fail 1\n# skipped 0"), "3 passed, 1 failed");
assert.equal(res("  5 passing (20ms)\n  1 failing"), "5 passed, 1 failed");
assert.equal(res("Finished in 1s\n5 examples, 1 failure, 1 pending"), "3 passed, 1 failed, 1 skipped");
assert.equal(res("ok  \tpkg/a\t0.2s\nok  \tpkg/b\t0.1s\n--- FAIL: TestX (0.00s)\nFAIL\tpkg/c\t0.1s"), "2 passed, 1 failed");
assert.equal(testResult("nothing to see"), null);
assert.equal(testResult(undefined), null);
assert.equal(testLine(null), "");
console.log("bashkind.check: ok");
