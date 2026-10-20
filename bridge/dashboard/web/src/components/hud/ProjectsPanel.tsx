/* The PROJECTS sidebar panel is gone — projects are browsed in the sessions
   panel's PROJECTS mode and managed from SETTINGS ▸ Projects. What is left is
   the shape both of those share; the grouping rule is lib/projectlist's parentOf. */
import type { GitBadge, SessionBrief } from "../../api";

export interface ProjectGroup {
  rel: string;
  name: string;
  badge?: GitBadge;
  sessions: SessionBrief[]; // most-recent few, for display (capped)
  sessionCount: number; // true total, for the count label
  running: boolean;
}
