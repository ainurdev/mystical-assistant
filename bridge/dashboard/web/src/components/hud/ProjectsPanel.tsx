/* The PROJECTS sidebar panel is gone — projects are browsed in the sessions
   panel's PROJECTS mode and managed from SETTINGS ▸ SYSTEM. What is left is
   the shape both of those share, and the grouping rule they group by. */
import type { GitBadge, SessionBrief } from "../../api";

export interface ProjectGroup {
  rel: string;
  name: string;
  badge?: GitBadge;
  sessions: SessionBrief[]; // most-recent few, for display (capped)
  sessionCount: number; // true total, for the count label
  running: boolean;
}


/** Owning folder of a repo path: "ainurhq/efas/app" → "ainurhq/efas",
 *  "aligned" → "" (top level). Shared with the manage modal so both group
 *  projects the same way. */
export function parentOf(rel: string): string {
  const clean = rel.replace(/^\/+|\/+$/g, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? "" : clean.slice(0, i);
}
