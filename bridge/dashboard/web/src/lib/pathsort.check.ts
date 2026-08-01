// Run: node bridge/dashboard/web/src/lib/pathsort.check.ts
import { cmpTreePath } from "./pathsort.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const sorted = [
  "app/artisan",
  ".gitignore",
  "config/app.php",
  "app/Http/Kernel.php",
  ".github/workflows/ci.yml",
  "README.md",
  "app/zz.php",
].sort(cmpTreePath);

ok(
  JSON.stringify(sorted) === JSON.stringify([
    ".github/workflows/ci.yml",
    "app/Http/Kernel.php",
    "app/artisan",
    "app/zz.php",
    "config/app.php",
    ".gitignore",
    "README.md",
  ]),
  `folders first at every depth, then files: ${sorted.join(" ")}`,
);

console.log("all ok");
