// Run: node bridge/dashboard/web/src/lib/divergence.check.ts
import { divergence } from "./divergence.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.1;

const a = divergence({ ahead: 12, behind: 0, landed: false });
ok(near(a.right, 20.05) && a.left === 0 && a.ahead === "12" && a.behind === "" && !a.merged, `12 ahead - ${JSON.stringify(a)}`);
ok(divergence({ ahead: 0, behind: 0, landed: false }).right === 0, "0 draws 0");
let prev = 0, mono = true, fits = true;
for (let n = 0; n <= 500; n++) {
  const r = divergence({ ahead: n, behind: 0, landed: false }).right;
  if (r < prev) mono = false;
  if (r > 36) fits = false;
  prev = r;
}
ok(mono, "bars never shrink as counts grow (0..500)");
ok(fits, "no bar over 36px");
ok(divergence({ ahead: 455, behind: 0, landed: false }).right > divergence({ ahead: 12, behind: 0, landed: false }).right, "455 ahead draws longer than 12");
const w = divergence({ ahead: 455, behind: 300, landed: false });
ok(w.left === 36 && w.right === 36 && w.ahead === "99+" && w.behind === "99+", `99+/99+ fits - ${JSON.stringify(w)}`);
const m = divergence({ ahead: 3, behind: 1, landed: true });
ok(m.merged && m.left === 0 && m.right === 0 && m.ahead === "" && m.behind === "", "landed: merged, no widths");
