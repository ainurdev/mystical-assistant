/** NEW SESSION's two decisions, apart from the popover that draws them
 *  (components/hud/NewSessionPop): which projects lead its list, and which call
 *  a start becomes. */
import type { SessionBrief } from "../api";
import { jobGroup, JOBS_REL } from "./jobs.ts";
import { SHARED_REL } from "./team.ts";

/** Projects you can start a session in: the one you're in first, then by your
 *  newest session there. The inline form this replaced listed them in path
 *  order, which put Rivendell (170 of 396 sessions one month) behind SHOW ALL.
 *  The Rivendell jobs and Shared groups are not folders of yours, and a job's
 *  start says nothing about where you work, so neither counts. */
export function rankProjects<G extends { rel: string }>(
  groups: G[], sessions: Pick<SessionBrief, "project" | "origin" | "job" | "created" | "updated">[], here: string | null,
): { list: G[]; started: Map<string, number> } {
  const started = new Map<string, number>();
  for (const s of sessions) {
    const g = jobGroup(s), t = s.created ?? s.updated;
    if (t > (started.get(g) ?? 0)) started.set(g, t);
  }
  const list = groups
    .filter((g) => g.rel !== JOBS_REL && g.rel !== SHARED_REL)
    .sort((a, b) => Number(b.rel === here) - Number(a.rel === here) || (started.get(b.rel) ?? 0) - (started.get(a.rel) ?? 0));
  return { list, started };
}

/** The call a start becomes: a new branch makes a worktree, another existing
 *  branch gets one, and the checkout's own branch (or one we can't place) is a
 *  plain session in the checkout. */
export function startCall(branch: string, checkout: string | undefined, create: boolean, parent?: string):
  { worktree: false } | { worktree: true; branch: string; create: boolean; parent?: string } {
  if (create) return { worktree: true, branch, create: true, parent: parent || undefined };
  if (checkout && branch && branch !== checkout) return { worktree: true, branch, create: false };
  return { worktree: false };
}
