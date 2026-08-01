// Run: node bridge/dashboard/web/src/lib/langfor.check.ts
import { langFor } from "./langfor.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const cases: [string, string | null][] = [
  ["src/app.tsx", "TSX"],
  ["bridge/git.py", "Python"],
  ["Cargo/src/main.rs", "Rust"],
  ["cmd/server/main.go", "Go"],
  ["app/Http/Kernel.php", "PHP"],
  ["src/Main.java", "Java"],
  ["lib/thing.rb", "Ruby"],
  ["scripts/deploy.sh", "Shell"],
  [".github/workflows/ci.yml", "YAML"],
  ["pyproject.toml", "TOML"],
  ["db/schema.sql", "SQL"],
  ["pom.xml", "XML"],
  ["docker/Dockerfile", "Dockerfile"],   // filename match, no extension
  ["README.MD", "Markdown"],             // lowercase fallback
  ["notes.txt", null],                   // unknown → plain text, no crash
];

for (const [path, want] of cases)
  ok(langFor(path)?.name === want || (want === null && langFor(path) === null),
     `${path} → ${want ?? "plain"} (got ${langFor(path)?.name ?? "plain"})`);

console.log("all ok");
