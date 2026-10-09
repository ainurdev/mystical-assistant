// Run: node bridge/dashboard/web/src/lib/surfaces.check.ts
import { fmtReset, projectGivenName, projectLabelsFor, projectName, setProjectNames, usageWindows, windowLabels } from "./surfaces.ts";

const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const cases: [string, string][] = [
  [at(2 * 3_600_000 + 14 * 60_000 + 5_000), "2H14M"],
  [at(59 * 60_000), "0H59M"],
  [at(128 * 3_600_000 + 3 * 60_000), "5D08H"],   // weekly window, not "128H03M"
  [at(24 * 3_600_000), "1D00H"],
  [at(-5_000), "now"],
];
for (const [iso, want] of cases) {
  const got = fmtReset(iso);
  console.assert(got === want, `fmtReset(${iso}) → ${got}, wanted ${want}`);
}
console.assert(fmtReset(null) === "—", "null → —");

const both = windowLabels({
  five_hour: { percent: 5, resets_at: at(31 * 60_000) },
  seven_day: { percent: 30, resets_at: at(128 * 3_600_000) },
});
console.assert(both.join(" · ") === "5H 95% 0H31M · WK 70% 5D08H", `windows → ${both}`);
console.assert(windowLabels({ five_hour: null, seven_day: null }).length === 0, "no meter → no labels");
console.assert(windowLabels({}).length === 0, "absent buckets → no labels");

// The same windows as numbers, not labels — what windowLabels formats.
const wins = usageWindows({
  five_hour: { percent: 5.4, resets_at: at(31 * 60_000 + 5_000), severity: "normal" },
  seven_day: { percent: 99.6, resets_at: at(128 * 3_600_000 + 3 * 60_000), severity: "critical" },
});
console.assert(JSON.stringify(wins) === JSON.stringify([
  { tag: "5H", left: 95, severity: "normal", reset: "0H31M" },
  { tag: "WK", left: 0, severity: "critical", reset: "5D08H" },
]), `usageWindows → ${JSON.stringify(wins)}`);
console.assert(usageWindows({ five_hour: { percent: 120, resets_at: null } })[0].left === 0, "past the cap reads 0 left, not negative");
console.assert(usageWindows({ five_hour: { percent: 10, resets_at: null } })[0].severity === "normal", "no severity reads normal");


// Project labels: a bare name unless another project reads the same, then as
// many parent folders as it takes to tell them apart.
const expectLabels = (got: Record<string, string>, want: Record<string, string>, what: string) => {
  for (const k of new Set([...Object.keys(got), ...Object.keys(want)]))
    console.assert(got[k] === want[k], `${what}: ${k} → ${got[k]}, wanted ${want[k]}`);
};
expectLabels(projectLabelsFor(["/ainur/efas/app", "/ainur/nr/app", "/ainur/elvou", "/ainur/mystical-assistant/"]), {
  "/ainur/efas/app": "efas/app", "/ainur/nr/app": "nr/app", "/ainur/elvou": "elvou", "/ainur/mystical-assistant": "mystical-assistant",
}, "twins");
expectLabels(projectLabelsFor(["/a/x/app", "/b/x/app", "/c/app"]), {
  "/a/x/app": "a/x/app", "/b/x/app": "b/x/app", "/c/app": "c/app",
}, "same parent name, deeper split");
expectLabels(projectLabelsFor(["/app", "/ainur/app"]), { "/app": "app", "/ainur/app": "ainur/app" }, "top-level twin");
expectLabels(projectLabelsFor(["/x/foo", "/y/app"], { "/x/foo": "app" }), { "/x/foo": "x/app", "/y/app": "y/app" }, "given name collides");
expectLabels(projectLabelsFor(["/ainur/elvou", "/ainur/nr/app"], { "/ainur/elvou": "Elvou!" }), { "/ainur/elvou": "Elvou!", "/ainur/nr/app": "app" }, "given name, no twin");
expectLabels(projectLabelsFor(["/ainur/nr/app/", "/ainur/nr/app"]), { "/ainur/nr/app": "app" }, "same rel twice is no twin");
console.assert(Object.keys(projectLabelsFor([])).length === 0, "no rels → no labels");

// projectName() reads the labels of the last listing; anything unlisted keeps its basename.
setProjectNames({}, ["/ainur/efas/app", "/ainur/nr/app", "/ainur/elvou"]);
console.assert(projectName("/ainur/efas/app") === "efas/app", `listed twin → ${projectName("/ainur/efas/app")}`);
console.assert(projectName("/ainur/nr/app/") === "nr/app", "trailing slash finds the label");
console.assert(projectName("/ainur/elvou") === "elvou", "listed, no twin → bare");
console.assert(projectName("/somewhere/app") === "app", "unlisted → basename");
console.assert(projectName(null) === "proj", "null → proj");
setProjectNames({ "/ainur/nr/app": "NR" }, ["/ainur/efas/app", "/ainur/nr/app"]);
console.assert(projectName("/ainur/nr/app") === "NR", "given name wins");
console.assert(projectName("/ainur/efas/app") === "app", "renamed twin frees the other");
console.assert(projectGivenName("/ainur/nr/app") === "NR" && projectGivenName("/ainur/efas/app") === "", "given name is what the rename box starts from");
setProjectNames({});
console.assert(projectName("/ainur/efas/app") === "app", "no listing → basename");

console.log("surfaces.check ok");
