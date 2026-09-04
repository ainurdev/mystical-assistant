// Run: node bridge/dashboard/web/src/lib/surfaces.check.ts
import { fmtReset } from "./surfaces.ts";

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
console.log("surfaces.check ok");
