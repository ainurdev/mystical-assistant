// Run: node bridge/dashboard/web/src/lib/footprint.check.ts
import { footprint } from "./footprint.ts";
import { sessionEdits } from "./sessionedits.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const R = "/r";
const mk = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`);

const mock = footprint(new Set([...mk("apps/web/src", 9), ...mk("packages/ui/src", 4), ...mk("e2e", 2), "docs/a.md"]), "docs/a.md", R);
console.assert(mock.total === 16, "mock: 16 files");
console.assert(same(mock.folders, [{ name: "apps/web", count: 9 }, { name: "packages/ui", count: 4 }, { name: "e2e", count: 2 }, { name: "docs", count: 1 }]), "mock: folders by count");
console.assert(same(mock.recent, [{ name: "f0.ts", now: false }, { name: "f1.ts", now: false }, { name: "a.md", now: true }]), "mock: last 3 as basenames, live one flagged");

const none = footprint(new Set(), null, R);
console.assert(none.total === 0 && none.folders.length === 0 && none.recent.length === 0, "empty: nothing");

const many = footprint(new Set(Array.from({ length: 40 }, (_, i) => `d${i % 9}/s/f${i}.ts`)), null, R);
console.assert(many.total === 40 && many.folders.length === 5 && many.folders[4].name === "other", "40/9: 4 + other");
console.assert(many.folders.reduce((s, f) => s + f.count, 0) === 40, "40/9: counts add up");

console.assert(same(footprint(new Set(["README.md"]), null, R).folders, [{ name: "/", count: 1 }]), "top-level file: '/'");
console.assert(footprint(new Set(["/r/e2e/a.ts"]), null, R).folders[0].name === "e2e", "absolute path under root is made relative");

// A file written again is the most recent, not stuck at its first position.
const t = (p: string) => ({ status: "done", events: [{ type: "tool", name: "Write", summary: `/r/${p}` }] });
const se = sessionEdits([t("a"), t("b"), t("a")], R);
console.assert(same([...se.edited], ["b", "a"]), "re-edit moves to the end");
