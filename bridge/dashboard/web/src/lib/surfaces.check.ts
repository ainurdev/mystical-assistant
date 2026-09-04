// Run: node bridge/dashboard/web/src/lib/surfaces.check.ts
import { fmtReset, windowLabels } from "./surfaces.ts";

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

console.log("surfaces.check ok");
