// Run: node bridge/dashboard/web/src/lib/sessionfilter.check.ts
import { isOnlyMine, kindsOf, offSay, onlyMine, sameShow, SHOW_ALL, shows } from "./sessionfilter.ts";

const ONLY_MINE = onlyMine(SHOW_ALL);

const mine = { origin: "dashboard", project: "/app", title: "fix the login", asked: 1700000000 };
const job = { origin: "rivendell:production", project: "/app", title: "fix: EFA-364 patch vite", asked: 1700000000, job: { kind: "review" as const } };
const share = { origin: "team:c76c23d5", project: "/", title: "their session", asked: null };
const term = { origin: "terminal", project: "/app", title: "refactor the parser", asked: null };
const stub = { origin: "terminal", project: "/app", title: null, asked: null };
const blank = { origin: "dashboard", project: "/app", title: null, asked: null };

console.assert(kindsOf(mine).length === 0, "your own session is no kind");
console.assert(kindsOf({ ...mine, origin: "bot" }).length === 0 && kindsOf({ ...mine, origin: "miniapp" }).length === 0, "Telegram and the Mini App are yours");
console.assert(kindsOf(job).join() === "jobs", "a Rivendell run is a job, prompt or not");
console.assert(kindsOf({ origin: "terminal", project: "/.bridge_uploads/meetings", title: null, asked: null }).join() === "jobs", "a meeting run by hand is a job, not an empty terminal session");
console.assert(kindsOf(share).join() === "team", "a share is only a share, whatever its turns");
console.assert(kindsOf(term).join() === "cli", "a terminal session with a transcript title has something in it");
console.assert(kindsOf({ ...term, origin: "vscode" }).join() === "cli", "VS Code counts with the terminal");
console.assert(kindsOf(stub).join() === "cli,empty", "an untitled terminal session is both");
console.assert(kindsOf(blank).join() === "empty", "opened and never prompted");
console.assert(kindsOf({ ...blank, asked: 1700000000 }).length === 0, "a first turn in flight is not empty, untitled or not");
console.assert(kindsOf({ ...blank, title: "from NEXT UP" }).length === 0, "a session started with a title reads as one");
console.assert(kindsOf({ origin: "dashboard", project: "/app", title: null }).join() === "empty", "an older bridge sends no asked: no title still means no prompt");

console.assert([mine, job, share, term, stub, blank].every((s) => shows(SHOW_ALL, s)), "everything shows by default");
console.assert(shows(ONLY_MINE, mine) && shows(ONLY_MINE, term), "ONLY MINE keeps yours, terminal ones with something in them too");
console.assert(!shows(ONLY_MINE, job) && !shows(ONLY_MINE, share) && !shows(ONLY_MINE, blank), "and drops jobs, shares and empty rows");
console.assert(!shows(ONLY_MINE, stub), "an empty terminal session goes with the empty ones");
console.assert(!shows({ ...SHOW_ALL, cli: false }, term) && !shows({ ...SHOW_ALL, cli: false }, stub), "terminal off drops every terminal session");
console.assert(shows({ ...SHOW_ALL, cli: false }, blank), "but not your own empty one");

console.assert(sameShow(SHOW_ALL, { jobs: true, team: true, cli: true, empty: true }) && !sameShow(SHOW_ALL, ONLY_MINE), "presets compare by value");
console.assert(offSay(ONLY_MINE) === "Rivendell jobs, shares, empty sessions" && offSay(SHOW_ALL) === "", "what's off, as words, in menu order");
console.assert(onlyMine({ ...SHOW_ALL, cli: false }).cli === false, "ONLY MINE leaves the terminal tick where you put it");
console.assert(isOnlyMine(ONLY_MINE) && isOnlyMine({ ...ONLY_MINE, cli: false }) && !isOnlyMine(SHOW_ALL), "terminal off is still only yours");
console.assert(!isOnlyMine({ ...ONLY_MINE, empty: true }), "empty rows on is not");

console.log("sessionfilter checks done");
