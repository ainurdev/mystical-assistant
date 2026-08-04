// Run: node bridge/dashboard/web/src/lib/filepath.check.ts
import { parseFileRef } from "./filepath.ts";

const yes: [string, string, number | undefined][] = [
  ["bridge/runner.py", "bridge/runner.py", undefined],
  ["src/App.tsx:42", "src/App.tsx", 42],
  ["src/App.tsx:42:9", "src/App.tsx", 42],          // col dropped, line kept
  ["./bridge/git.py", "bridge/git.py", undefined],
  ["README.md", "README.md", undefined],            // bare name, known extension
  ["a/b/c", "a/b/c", undefined],                    // no extension, but deep enough
  ["tests/test_git.py", "tests/test_git.py", undefined],
];
for (const [input, path, line] of yes) {
  const r = parseFileRef(input);
  console.assert(r?.path === path && r?.line === line,
    `${input} → ${JSON.stringify(r)}, wanted ${path}${line ? `:${line}` : ""}`);
}

const no = [
  "npm run build",        // whitespace
  "useState",             // bare identifier
  "--force",              // a flag
  "a/b",                  // too shallow, no extension
  "https://x.dev/a.ts",   // a URL
  "/etc/passwd",          // absolute
  "~/.claude/x.md",       // home-relative
  "C:\\Users\\a.ts",      // windows absolute
  "src/*.ts",             // a glob
  "foo(bar)",             // a call
  "",
];
for (const s of no)
  console.assert(parseFileRef(s) === null, `${JSON.stringify(s)} should not be a file ref`);

console.log("filepath ok");
