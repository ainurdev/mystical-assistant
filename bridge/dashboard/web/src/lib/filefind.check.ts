// Run: node bridge/dashboard/web/src/lib/filefind.check.ts
import { findFiles } from "./filefind.ts";

const tree = [
  "src/components/app/data-table.tsx",
  "src/components/ui/table.tsx",
  "src/components/app/student-table.stories.tsx",
  "docs/decisions/2026-10-28-table-sort.md",
  "docs/tables/readme.md",          // "table" only in a folder
  "README.md",
];

const none = findFiles(tree, "   ");
console.assert(none.total === 0 && none.hits.length === 0, "a blank query finds nothing");

const t = findFiles(tree, "TABLE");
console.assert(t.total === 5, `5 paths hold "table", got ${t.total}`);
console.assert(t.hits[0].path === "src/components/ui/table.tsx", `a name that starts with it leads, got ${t.hits[0].path}`);
console.assert(t.hits[t.hits.length - 1].path === "docs/tables/readme.md", "a folder-only match comes last");
console.assert(t.hits[0].name === "table.tsx" && t.hits[0].dir === "src/components/ui" && t.hits[0].at === 0,
  `name, dir and the match's start, got ${JSON.stringify(t.hits[0])}`);
console.assert(t.hits[t.hits.length - 1].at === -1, "a folder match marks nothing in the name");

const shots = findFiles([...tree, "test/screenshots/table-paging-light-chromium.png"], "table");
console.assert(shots.hits[1].path === "src/components/app/data-table.tsx",
  `a short name beats a long one that merely starts with it, got ${shots.hits[1].path}`);

const scratch = findFiles(["out/table.png", "src/data-table.tsx", "docs/tables/a.md"], "table", 60, (p) => p.startsWith("out/"));
console.assert(scratch.hits.map((h) => h.path).join() === "src/data-table.tsx,docs/tables/a.md,out/table.png",
  `a git-ignored path comes after every other match, got ${scratch.hits.map((h) => h.path)}`);

const cut = findFiles(tree, "table", 2);
console.assert(cut.hits.length === 2 && cut.total === 5, "the limit cuts the list, not the count");

const top = findFiles(tree, "readme");
console.assert(top.hits[0].path === "README.md" && top.hits[0].dir === "", `a root file has no dir, got ${JSON.stringify(top.hits[0])}`);
console.log("filefind ok");
