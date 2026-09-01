// Run: node bridge/dashboard/web/src/lib/progressline.check.ts
import { collapseProgress, parseProgress } from "./progressline.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

// The two shapes that actually reach us: sdkmanager's, label in front, and the
// monitor's, label behind.
ok(
  parseProgress("Downloading x86_64-36_r07.zip...  [=====    ] 33%")?.pct === 33,
  "sdkmanager's own bar reads",
);
ok(
  parseProgress("[####......] 40%  Unzipping... x86_64/system.img")?.label ===
    "Unzipping... x86_64/system.img",
  "the label is whatever sits outside the bar",
);
ok(parseProgress("[██████░░░░] 40% · system image")?.pct === 40, "unicode fill");
ok(parseProgress("[                 ] 0% Loading")?.pct === 0, "an empty bar is still a bar");

// Prose must not turn into a meter.
ok(parseProgress("see [1] 50% of the time") === null, "a citation is not a bar");
ok(parseProgress("100% done, no bar here") === null, "a percentage alone is not a bar");
ok(parseProgress("[====]") === null, "a bar with no percentage");
ok(parseProgress("nothing at all") === null, "plain prose");

// 100 is the ceiling even when a tool overshoots.
ok(parseProgress("[##########] 137%")?.pct === 100, "percent is clamped");

const rows = collapseProgress(
  ["STEP 4/5: installing packages", "[#.........] 10% a", "[#####.....] 50% a", "[########..] 80% b",
   "STEP 5/5: creating AVD", "[#.........] 10% c"].join("\n"),
);
ok(rows.length === 4, "a run of redraws collapses to one bar");
ok(rows[0] === "STEP 4/5: installing packages", "headings survive in place");
ok(typeof rows[1] !== "string" && rows[1].pct === 80, "the run keeps the state it ended on");
ok(rows[2] === "STEP 5/5: creating AVD", "a heading breaks the run");
ok(typeof rows[3] !== "string" && rows[3].pct === 10, "the next run starts fresh");

ok(collapseProgress("just prose\nmore prose").every((r) => typeof r === "string"),
   "a block with no bars is untouched");
console.log("\nprogressline: all checks passed");
