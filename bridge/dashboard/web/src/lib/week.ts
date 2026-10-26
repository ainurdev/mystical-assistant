import type { WeeklyReport } from "../api";
import { projectName } from "./surfaces.ts";

/* The USAGE tab's arithmetic (hud/UsagePanel), kept free of React so
 * week.check.ts can run it under node. */

export function fmtTokens(n: number): string {
  if (n >= 999.5e6) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 999.5e3) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

export function dur(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return s < 360_000 ? `${(s / 3600).toFixed(1).replace(/\.0$/, "")}h` : `${Math.round(s / 3600)}h`;
}

export function pct(cur: number, prev: number): string {
  const n = Math.round((100 * (cur - prev)) / prev);
  return n >= 0 ? `+${n}%` : `−${Math.abs(n)}%`;
}

/** Mon..Sun for the report's span, each with the day's agent time written in. */
export function daysOf(rep: WeeklyReport) {
  const by = new Map(rep.days.map((d) => [d.day, d]));
  return Array.from({ length: 7 }, (_, i) => {
    // Noon, not midnight, so a DST edge can't bleed into the neighbouring date.
    const date = new Date((rep.since + i * 86400) * 1000 + 12 * 3600 * 1000);
    const key = date.toLocaleDateString("sv-SE");   // YYYY-MM-DD, the bridge's own bucket key
    return { i, key, date, label: "MTWTFSS"[i], ...(by.get(key) ?? { turns: 0, elapsed: 0 }) };
  });
}

/** The week as a markdown table, for a timesheet or an invoice. */
export function timesheet(rep: WeeklyReport): string {
  const fmt = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const t = rep.totals;
  return [
    `Week ${fmt(rep.since)} – ${fmt(rep.until - 43200)}`, "",
    "| Project | Agent time | Sessions | Turns |", "|---|---:|---:|---:|",
    ...rep.projects.map((p) => `| ${projectName(p.project) || p.project} | ${dur(p.elapsed)} | ${p.sessions} | ${p.turns} |`),
    `| **Total** | **${dur(t.elapsed)}** | **${t.sessions}** | **${t.turns}** |`,
  ].join("\n");
}
