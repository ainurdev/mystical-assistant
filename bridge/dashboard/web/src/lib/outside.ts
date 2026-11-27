// Outside projects: one sidebar group for every session whose folder is outside
// your projects root (GLOSSARY.md). Only a session the bridge found running
// elsewhere (the Claude app, a terminal, VS Code) can be one: bridge/native.py
// labels it with its own ~-collapsed path where yours carry a path under the
// root. Every Claude app session gets its own random scratch folder, so a group
// per folder made one odd group per session. Like Rivendell jobs, the group only
// lists them; each still runs in its own folder.

/** The group's key in the PROJECTS tree. Not a path (those start with "/"), so it
 *  can't collide with a folder. */
export const OUTSIDE_REL = "outside:projects";
export const OUTSIDE_NAME = "Outside projects";

type Listed = { project: string; cwd?: string | null };

/** Was this session found running outside your projects root? Its label is its
 *  own path: ~-collapsed under your home, the folder itself anywhere else. */
export const isOutside = (s: Listed): boolean => s.project.startsWith("~") || (!!s.cwd && s.project === s.cwd);

// The Claude desktop app's folder for a session started in no project.
const CLAUDE_APP_FOLDER = /\/Claude\/scratch-workspaces\//;

/** Where an outside session ran, on its row: "Claude app" for the desktop app's
 *  scratch sessions, else its path. */
export const outsideLabel = (s: Listed): string => (CLAUDE_APP_FOLDER.test(s.project) ? "Claude app" : s.project);
