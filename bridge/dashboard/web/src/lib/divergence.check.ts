// Run: node bridge/dashboard/web/src/lib/divergence.check.ts
import { divergence } from "./divergence.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.1;

const a = divergence({ ahead: 12, behind: 0, landed: false });
ok(near(a.right, 48.5) && a.left === 0 && a.ahead === "12" && a.behind === "" && !a.merged, `12 ahead — ${JSON.stringify(a)}`);
const b = divergence({ ahead: 2, behind: 5, landed: false });
ok(near(b.left, 31.3) && near(b.right, 19.8), `5 behind 2 ahead — ${JSON.stringify(b)}`);
ok(divergence({ ahead: 77, behind: 0, landed: false }).right === 56, "77 ahead caps at 56");
ok(divergence({ ahead: 150, behind: 100, landed: false }).ahead === "99+" && divergence({ ahead: 0, behind: 100, landed: false }).behind === "99+", "over 99 reads 99+");
const m = divergence({ ahead: 3, behind: 1, landed: true });
ok(m.merged && m.left === 0 && m.right === 0 && m.ahead === "" && m.behind === "", "landed: merged, no widths");
