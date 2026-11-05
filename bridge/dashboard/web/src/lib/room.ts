/* The Team hero's room: who stands in it. On-now first (the order byPresence gives),
   5 at most, the rest fold into "+N". The caption names the first person on now and
   when they came on, plus the latest teammate who left within the hour.
   Only what the roster already has: there is no "where" (project) in presence. */
import type { Teammate } from "../api";
import { ago } from "./surfaces.ts";
import { presence } from "./team.ts";

const MAX = 5;
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

export function room(roster: Teammate[], now: number, h12?: boolean) {
  const sorted = [...roster].sort((a, b) => Number(b.online) - Number(a.online));   // stable: keeps the name order within each
  const on = sorted.filter((t) => t.online);
  const lead = on[0];
  const left = sorted.filter((t) => !t.online && t.lastSeenAt && Date.parse(t.lastSeenAt) / 1000 > now - 3600)
    .sort((a, b) => Date.parse(b.lastSeenAt!) - Date.parse(a.lastSeenAt!))[0];
  const gone = left ? ago(Date.parse(left.lastSeenAt!) / 1000, now) : "";
  const bits = [
    lead ? `${first(lead.name)} is ${presence(lead, now, h12)}` : "",
    left ? `${first(left.name)} left ${gone === "now" ? "just now" : `${gone} ago`}` : "",
  ].filter(Boolean);
  return { shown: sorted.slice(0, MAX), more: Math.max(0, sorted.length - MAX), on: on.length, lead, caption: bits.join(" · ") || (sorted.length ? "nobody is on right now" : "") };
}
