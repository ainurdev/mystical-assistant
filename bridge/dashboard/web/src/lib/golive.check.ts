// Run: node bridge/dashboard/web/src/lib/golive.check.ts
import { commitsOf, popFor, verb } from "./golive.ts";
import type { LivePart } from "../api";

const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const part = (key: LivePart["key"], act: LivePart["act"], commits: [string, number][]): LivePart =>
  ({ key, name: key, act, since: 0, commits: commits.map(([sha, at]) => ({ sha, at, subject: sha })), dirty: 0, files: commits.length });

const dash = part("dashboard", "rebuild", [["c3", 30], ["b2", 20]]);
const mini = part("miniapp", "rebuild", [["b2", 20]]);
const py = part("bridge", "restart", [["d4", 40]]);

// The verb says what will happen.
eq(verb([dash, mini]), "REBUILD", "apps only");
eq(verb([py]), "RESTART", "bridge only");
eq(verb([dash, py]), "REBUILD & RESTART", "both");

// A commit touching two parts counts once; newest first.
eq(commitsOf([dash, mini, py]).map((c) => c.sha), ["d4", "c3", "b2"], "union");

// It pops for what landed since it last looked, and only then.
eq(popFor([dash, mini, py], 20), { newest: { sha: "d4", at: 40, subject: "d4" }, fresh: 2 }, "two new");
eq(popFor([dash, mini, py], 40), null, "nothing new");
eq(popFor([part("dashboard", "rebuild", [])], 0), null, "uncommitted edits alone never pop");

console.log("golive.check: ok");
