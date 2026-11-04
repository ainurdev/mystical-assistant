// The sidebar's SHOW filter (the funnel beside the search). Your own sessions,
// started here, in Telegram or the Mini App and prompted, always list; every other
// kind is a tick, all on by default. PLUGINS ignores it, so a job or share the
// filter hides is still a click away there. App owns the state: the workspace
// switch counts by it too. Checked by sessionfilter.check.ts.
import type { SessionBrief } from "../api";
import { isJob } from "./jobs.ts";
import { isTeam } from "./team.ts";

export type Kind = "jobs" | "team" | "cli" | "empty";
/** Each kind's tick: true lists it. */
export type Show = Record<Kind, boolean>;

export const SHOW_ALL: Show = { jobs: true, team: true, cli: true, empty: true };

/** ONLY MINE. A terminal session is yours too, so its tick stays as you left it. */
export const onlyMine = (show: Show): Show => ({ ...show, jobs: false, team: false, empty: false });
export const isOnlyMine = (show: Show): boolean => !show.jobs && !show.team && !show.empty;

export const KINDS: { k: Kind; label: string; say: string; tip: string }[] = [
  { k: "jobs", label: "Rivendell jobs", say: "Rivendell jobs", tip: "Reviews, papers, briefs and builds Rivendell ran" },
  { k: "team", label: "From teammates", say: "shares", tip: "Sessions a teammate sent you" },
  { k: "cli", label: "Terminal · VS Code", say: "terminal sessions", tip: "Claude Code sessions you ran in a terminal or VS Code" },
  { k: "empty", label: "Empty", say: "empty sessions", tip: "Opened and never prompted: untitled, with nothing in them" },
];

type Listed = Pick<SessionBrief, "origin" | "project" | "job" | "title" | "asked">;

/** A job or a share is only that; a terminal session can also be empty. Titles
 *  come from the first prompt (a terminal one's from its transcript), so no title
 *  and no prompt means nothing was ever asked. */
export function kindsOf(s: Listed): Kind[] {
  if (isTeam(s.origin)) return ["team"];
  if (isJob(s)) return ["jobs"];
  const k: Kind[] = [];
  if (s.origin === "terminal" || s.origin === "vscode") k.push("cli");
  if (!s.title && !s.asked) k.push("empty");
  return k;
}

/** Any of its kinds switched off keeps it out. */
export const shows = (show: Show, s: Listed): boolean => kindsOf(s).every((k) => show[k]);

export const sameShow = (a: Show, b: Show): boolean => KINDS.every(({ k }) => a[k] === b[k]);

/** What's off, as words for the funnel's tooltip. */
export const offSay = (show: Show): string => KINDS.filter(({ k }) => !show[k]).map(({ say }) => say).join(", ");
