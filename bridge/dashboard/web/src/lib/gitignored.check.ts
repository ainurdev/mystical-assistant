// Run: node bridge/dashboard/web/src/lib/gitignored.check.ts
import { ignoredMatcher } from "./gitignored.ts";

const isIgnored = ignoredMatcher(["node_modules/", ".env", "docs/build/"]);

const yes = [
  ".env",                          // a bare ignored file
  "node_modules",                  // the ignored dir's own row (no trailing slash)
  "node_modules/react/index.js",   // anything beneath it
  "docs/build",
  "docs/build/assets/app.css",
];
for (const p of yes) console.assert(isIgnored(p), `${p} should be ignored`);

const no = [
  "docs",                          // parent of an ignored dir, not ignored itself
  "docs/guide.md",
  ".env.example",                  // prefix of an entry, but a different file
  "src/node_modules_helper.ts",    // shares a prefix, isn't under the dir
  "README.md",
];
for (const p of no) console.assert(!isIgnored(p), `${p} should NOT be ignored`);

console.assert(!ignoredMatcher([])("anything"), "empty list ignores nothing");
console.log("gitignored.check.ts ok");
