// Run: node bridge/miniapp/web/src/lib/agentrows.check.ts
import { asSort, elapsedOf, FOLD_CAP, fmtElapsed, foldRows, nextSort, sortRows, startsOpen, tally } from "./agentrows.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const row = (name: string, status: string, updated: number, extra: { needs?: boolean; provider?: string; started?: number } = {}) =>
  ({ name, status, updated, needs: !!extra.needs, provider: extra.provider ?? "Claude", started: extra.started ?? 100 });
const names = (rows: { name: string }[]) => rows.map((r) => r.name).join(",");

const rows = [
  row("a-old", "done", 10),
  row("b-new", "done", 90),
  row("c-run", "running", 50),
  row("d-needs", "done", 5, { needs: true }),
  row("e-mid", "done", 40, { provider: "Kimi Code" }),
];

// Attention: needs-you, then running, then newest done.
ok(names(sortRows(rows, "attention")) === "d-needs,c-run,b-new,e-mid,a-old", "attention order");
ok(names(sortRows(rows, "newest")) === "b-new,c-run,e-mid,a-old,d-needs", "newest order");
ok(names(sortRows(rows, "name")) === "a-old,b-new,c-run,d-needs,e-mid", "name order");
ok(sortRows(rows, "provider")[4].name === "e-mid", "provider groups Kimi after Claude");

// The fold keeps three, picked by attention, ordered by your sort.
{
  const f = foldRows(rows, "attention", false);
  ok(f.shown.length === FOLD_CAP && f.hidden === 2, "three shown, two hidden");
  ok(names(f.shown) === "d-needs,c-run,b-new", "the three that matter");
}

// A sort that would bury it still can't hide what needs you.
{
  const f = foldRows(rows, "newest", false);
  ok(f.shown.some((r) => r.name === "d-needs"), "needs-you survives sort by newest");
  ok(names(f.shown) === "b-new,c-run,d-needs", "kept rows follow your sort");
  const g = foldRows(rows, "name", false);
  ok(g.shown.some((r) => r.name === "d-needs"), "needs-you survives sort by name");
}

// Four that need you are four rows, past the cap.
{
  const all = ["w", "x", "y", "z"].map((n) => row(n, "done", 1, { needs: true }));
  const f = foldRows([...all, row("v", "running", 2)], "attention", false);
  ok(f.shown.length === 4 && f.hidden === 1, "every needs-you row stays");
}

ok(foldRows(rows, "name", true).hidden === 0, "expanded hides nothing");
ok(foldRows(rows.slice(0, 2), "name", false).hidden === 0, "short lists don't fold");

ok(startsOpen(rows), "open while something runs");
ok(!startsOpen([row("a", "done", 1), row("b", "unknown", 2)]), "shut once all done");

ok(elapsedOf(row("a", "running", 150), 200) === 100, "running counts to now");
ok(elapsedOf(row("a", "done", 150), 200) === 50, "done counts to its last move");
ok(fmtElapsed(45) === "45s" && fmtElapsed(125) === "2m" && fmtElapsed(3900) === "1h 5m", "elapsed words");
ok(fmtElapsed(null) === "", "no start, no figure");

ok(asSort("name") === "name" && asSort("junk") === "attention", "a bad saved sort reads Attention");
ok(nextSort("provider") === "attention", "the control cycles");
ok(tally(rows) === "5 AGENTS · 1 NEEDS YOU · 1 RUNNING", tally(rows));
