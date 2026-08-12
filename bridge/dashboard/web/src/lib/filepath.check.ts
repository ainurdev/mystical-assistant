// Run: node bridge/dashboard/web/src/lib/filepath.check.ts
import { parseFileRef, resolveFileRef } from "./filepath.ts";

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

// resolveFileRef: a path in prose, matched against the tree it opens in.
const tree = [
  "bridge/git.py",
  "bridge/dashboard/web/src/App.tsx",
  "bridge/miniapp/web/src/lib/api.ts",
  "bridge/dashboard/web/src/api.ts",
];
const resolved: [string, string | null][] = [
  ["bridge/git.py", "bridge/git.py"],                                     // exact
  ["src/App.tsx", "bridge/dashboard/web/src/App.tsx"],                    // one suffix hit
  ["web/src/lib/api.ts", "bridge/miniapp/web/src/lib/api.ts"],            // deeper suffix
  ["src/api.ts", "bridge/dashboard/web/src/api.ts"],                      // suffix beats the lib/ one
  ["api.ts", null],                                                       // ambiguous: 2 bare hits
  ["bridge/invented.py", null],                                           // never existed
  ["git.py", "bridge/git.py"],                                            // bare name, unique
  ["App.tsx", "bridge/dashboard/web/src/App.tsx"],
];
for (const [input, want] of resolved) {
  const got = resolveFileRef(tree, input);
  console.assert(got === want, `resolve ${input} → ${got}, wanted ${want}`);
}

// Ambiguity broken by what the session touched (tool summaries, newest first).
const hinted: [string, string[], string | null][] = [
  ["api.ts", ["/home/me/proj/bridge/miniapp/web/src/lib/api.ts"], "bridge/miniapp/web/src/lib/api.ts"],
  ["api.ts", ["/home/me/proj/bridge/dashboard/web/src/api.ts"], "bridge/dashboard/web/src/api.ts"],
  ["api.ts", ["bridge/dashboard/web/src/api.ts"], "bridge/dashboard/web/src/api.ts"], // relative hint
  ["api.ts", ["/home/me/proj/bridge/git.py"], null],                      // hint is another file
  ["api.ts", [], null],                                                   // nothing touched yet
];
for (const [input, hints, want] of hinted) {
  const got = resolveFileRef(tree, input, hints);
  console.assert(got === want, `resolve ${input} +hints → ${got}, wanted ${want}`);
}

console.log("filepath ok");
