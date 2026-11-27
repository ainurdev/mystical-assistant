// Run: node --import ./tools/strict-assert.mjs src/lib/outside.check.ts  (from web/)
//
// Outside projects: the one sidebar group for sessions whose folder is outside
// your projects root, and what each of its rows says about where it ran.
import { jobGroup } from "./jobs.ts";
import { OUTSIDE_REL, outsideLabel } from "./outside.ts";

const SCRATCH = "Library/Application Support/Claude/scratch-workspaces/38057fa7/a9a8fcde/scratch-2026-11-23-1aad20";
const app = { origin: "terminal", project: `~/${SCRATCH}`, cwd: `/Users/me/${SCRATCH}` };

console.assert(jobGroup(app) === OUTSIDE_REL, "a Claude app session files under Outside projects, not a group of its own");
console.assert(jobGroup({ origin: "terminal", project: "/tmp/probe", cwd: "/tmp/probe" }) === OUTSIDE_REL,
  "a folder outside your home is labelled with itself, and is outside too");
console.assert(jobGroup({ origin: "terminal", project: "/mystical-assistant", cwd: "/Users/me/Projects/mystical-assistant" }) === "/mystical-assistant",
  "a terminal session in one of your projects stays in it");
console.assert(jobGroup({ origin: "dashboard", project: "/../Documents/site", cwd: "/Users/me/Documents/site" }) === "/../Documents/site",
  "a folder you made a project of from NEW PROJECT is a project, outside the root or not");
console.assert(jobGroup({ origin: "rivendell:a", project: "~/Downloads/x", cwd: "/Users/me/Downloads/x" }) !== OUTSIDE_REL,
  "a Rivendell job files under its own group, wherever it ran");

console.assert(outsideLabel(app) === "Claude app", "a Claude app session says so: its scratch folder's name means nothing");
console.assert(outsideLabel({ project: "~/Downloads/probe", cwd: "/Users/me/Downloads/probe" }) === "~/Downloads/probe", "anything else shows its path");
console.assert(outsideLabel({ project: "/tmp/probe", cwd: "/tmp/probe" }) === "/tmp/probe", "outside your home too");
console.assert(jobGroup({ origin: "terminal", project: "~", cwd: "/Users/me" }) === OUTSIDE_REL && outsideLabel({ project: "~" }) === "~",
  "a session started in your home folder lists there too, as ~");
console.log("outside.check: done");
