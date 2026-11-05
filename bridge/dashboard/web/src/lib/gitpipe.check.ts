// Run: node bridge/dashboard/web/src/lib/gitpipe.check.ts
import { pipe } from "./gitpipe.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const st = (p: ReturnType<typeof pipe>, k: string) => p.stations.find((s) => s.key === k)!;

const synced = pipe({ kind: "synced" }, 0, true);
console.assert(synced.action === null && synced.say === "Everything is on origin", "synced: nothing to move");
console.assert(synced.flows.length === 0 && st(synced, "mac").big === "✓" && st(synced, "origin").sub === "origin", "synced: calm");

const dirty = pipe({ kind: "synced" }, 5, true);
console.assert(same(dirty.action, { verb: "Commit", n: 5, gap: 0, tone: "acc" }), "dirty: Commit 5 on gap 0");
console.assert(st(dirty, "mac").hot && !st(dirty, "origin").hot && st(dirty, "mac").sub === "edits", "dirty: mac hot");
console.assert(dirty.say === "5 files edited, not committed", "dirty: say");

const ahead = pipe({ kind: "publish", n: 2 }, 0, false);
console.assert(same(ahead.action, { verb: "Publish", n: 2, gap: 1, tone: "acc" }), "no upstream: Publish 2 on gap 1");
console.assert(st(ahead, "origin").big === "—" && st(ahead, "origin").sub === "not pushed", "no upstream: origin dash");
console.assert(st(ahead, "branch").hot && st(ahead, "branch").big === "2", "ahead: branch hot");
console.assert(same(ahead.flows, [{ gap: 1, dir: 1, tone: "acc" }]), "ahead: one flow out");

const div = pipe({ kind: "diverged", ahead: 1, behind: 3 }, 0, true);
console.assert(same(div.action, { verb: "Pull", n: 3, gap: 1, tone: "warn" }), "diverged: Pull 3, warn");
console.assert(st(div, "origin").hot && st(div, "origin").warm && st(div, "origin").sub === "incoming", "diverged: origin hot+warm");
console.assert(same(div.flows, [{ gap: 1, dir: 1, tone: "acc" }, { gap: 1, dir: -1, tone: "warn" }]), "diverged: two flows on gap 1");

const behind = pipe({ kind: "behind", n: 4 }, 0, true);
console.assert(behind.action?.verb === "Pull" && same(behind.flows, [{ gap: 1, dir: -1, tone: "warn" }]), "behind: pull, one flow in");

const aheadUp = pipe({ kind: "ahead", n: 2 }, 0, true);
console.assert(aheadUp.action?.verb === "Publish" && st(aheadUp, "origin").big === "✓", "ahead of an upstream: Publish");

console.assert(st(pipe({ kind: "ahead", n: 120 }, 0, true), "branch").big === "99+", "120 ahead reads 99+");
console.assert(pipe({ kind: "publish", n: 0 }, 0, false).action === null, "no upstream, nothing ahead: no action");
console.assert(pipe({ kind: "none" }, 0, false).action === null, "no repo: no action");
console.log("gitpipe.check ok");
