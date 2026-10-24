// Run: node bridge/dashboard/web/src/lib/week.check.ts
import type { WeeklyReport } from "../api";
import { daysOf, dur, fmtTokens, pct, timesheet, tone } from "./week.ts";

// A window reads amber at a quarter left, red at a tenth, and the meter's own word wins either way.
console.assert(tone(26) === "" && tone(25) === "warn" && tone(11) === "warn" && tone(10) === "err", "tone thresholds");
console.assert(tone(80, "warning") === "warn" && tone(80, "exceeded") === "err" && tone(80, "normal") === "", "tone severity");

// Figures: a million never prints as 1000K, agent time drops a bare .0, a big week rounds to whole hours.
console.assert(fmtTokens(999_600) === "1.0M" && fmtTokens(176_431) === "176K" && fmtTokens(22.18e9) === "22.2B", "fmtTokens");
console.assert(dur(45) === "45s" && dur(3600) === "60m" && dur(7200) === "2h" && dur(22_320) === "6.2h" && dur(642_000) === "178h", "dur");
console.assert(pct(110, 100) === "+10%" && pct(94, 100) === "−6%", "pct");

// Mon..Sun from the report's start, each day's numbers by the bridge's local date key, missing days at zero.
const since = new Date(2026, 9, 19).getTime() / 1000;   // Monday Oct 19 2026, local midnight
const rep: WeeklyReport = {
  since, until: since + 7 * 86400,
  projects: [
    { project: "/ainurhq/rivendell", sessions: 92, turns: 245, elapsed: 323_001, tokens: 1, models: [] },
    { project: "/mystical-assistant", sessions: 72, turns: 135, elapsed: 251_979, tokens: null, models: [] },
  ],
  totals: { sessions: 164, turns: 380, elapsed: 574_980, tokens: null },
  days: [{ day: "2026-10-20", turns: 99, elapsed: 172_792 }],
  prev: { turns: 0, elapsed: 0, tokens: null },
};
const days = daysOf(rep);
console.assert(days.length === 7 && days[0].key === "2026-10-19" && days[6].key === "2026-10-25", `day keys ${days.map((d) => d.key)}`);
console.assert(days[1].turns === 99 && days[0].turns === 0 && days.map((d) => d.label).join("") === "MTWTFSS", "day numbers");

// The timesheet: a markdown table, one row a project, a bold total.
const md = timesheet(rep).split("\n");
console.assert(md[0] === "Week Oct 19 – Oct 25", `timesheet head: ${md[0]}`);
console.assert(md[2] === "| Project | Agent time | Sessions | Turns |" && md[3] === "|---|---:|---:|---:|", "timesheet columns");
console.assert(md[4] === "| rivendell | 89.7h | 92 | 245 |", `timesheet row: ${md[4]}`);
console.assert(md.at(-1) === "| **Total** | **160h** | **164** | **380** |", `timesheet total: ${md.at(-1)}`);
console.log("week.check: done");
