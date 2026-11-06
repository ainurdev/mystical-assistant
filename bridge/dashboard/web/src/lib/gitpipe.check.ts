// Run: node bridge/dashboard/web/src/lib/gitpipe.check.ts
import { pipe, track, type PipeSync } from "./gitpipe.ts";

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
console.assert(same(div.action, { verb: "Merge", n: 3, gap: 1, tone: "warn" }), "diverged: Merge 3, warn (git can't fast-forward)");
console.assert(same(div.alt, { verb: "Merge & push", n: 2 }), "diverged: Merge & push beside it, pushing yours + the merge");
console.assert(div.say === "You and origin both moved on", "diverged: say");
console.assert(st(div, "origin").hot && st(div, "origin").warm && st(div, "origin").sub === "incoming", "diverged: origin hot+warm");
console.assert(same(div.flows, [{ gap: 1, dir: 1, tone: "acc" }, { gap: 1, dir: -1, tone: "warn" }]), "diverged: two flows on gap 1");

const behind = pipe({ kind: "behind", n: 4 }, 0, true);
console.assert(behind.action?.verb === "Pull" && same(behind.flows, [{ gap: 1, dir: -1, tone: "warn" }]), "behind: pull, one flow in");

const aheadUp = pipe({ kind: "ahead", n: 2 }, 0, true);
console.assert(aheadUp.action?.verb === "Publish" && st(aheadUp, "origin").big === "✓", "ahead of an upstream: Publish");

const unch = pipe({ kind: "synced" }, 0, true, true);
console.assert(unch.say === "Not checked against origin yet" && unch.action === null, "unchecked synced: no claim");
console.assert(st(unch, "origin").big === "—" && st(unch, "origin").sub === "not checked", "unchecked: origin dimmed, not a green tick");
console.assert(pipe({ kind: "ahead", n: 2 }, 0, true, true).action?.verb === "Publish", "unchecked ahead still offers Publish");
console.assert(st(pipe({ kind: "ahead", n: 120 }, 0, true), "branch").big === "99+", "120 ahead reads 99+");
console.assert(pipe({ kind: "publish", n: 0 }, 0, false).action === null, "no upstream, nothing ahead: no action");
console.assert(pipe({ kind: "none" }, 0, false).action === null, "no repo: no action");

const dBehind = pipe({ kind: "behind", n: 3 }, 2, true);
console.assert(same(dBehind.action, { verb: "Pull", n: 3, gap: 1, tone: "warn" }) && dBehind.alt === null, "dirty + behind: Pull is primary");
const dAhead = pipe({ kind: "ahead", n: 2 }, 4, true);
console.assert(dAhead.action?.verb === "Commit" && same(dAhead.alt, { verb: "Push", n: 2 }), "dirty + ahead: Commit primary, Push 2 secondary");
console.assert(pipe({ kind: "publish", n: 1 }, 4, false).alt?.verb === "Publish", "dirty + unpublished: Publish secondary");
const dDiv = pipe({ kind: "diverged", ahead: 1, behind: 2 }, 3, true);
console.assert(dDiv.action?.verb === "Commit" && same(dDiv.alt, { verb: "Merge", n: 2 }), "dirty + diverged: Commit, Merge still yours to press");
console.assert(pipe({ kind: "ahead", n: 2 }, 0, true).alt === null && pipe({ kind: "synced" }, 4, true).alt === null, "no secondary when clean or nothing ahead");
console.assert(pipe({ kind: "synced" }, 0, true, false, "fork/x").say === "Everything is on fork/x", "a non-origin upstream is named");

// track(): the delivery tracker's sentence, next hop, lit stop and three stops (these throw).
const ok = (c: boolean, m: string) => { if (!c) throw new Error(`gitpipe.check: ${m}`); };
const tr = (sync: PipeSync, changed: number, hasUp = true, unchecked = false) => {
  const up = sync.kind === "diverged" ? sync.ahead ?? 0 : sync.kind === "ahead" || sync.kind === "publish" ? sync.n ?? 0 : 0;
  const down = sync.kind === "diverged" ? sync.behind ?? 0 : sync.kind === "behind" ? sync.n ?? 0 : 0;
  return track(pipe(sync, changed, hasUp, unchecked), { changed, up, down });
};
const vals = (t: ReturnType<typeof tr>) => t.stops.map((s) => s.value);
const t1 = tr({ kind: "ahead", n: 12 }, 3);
ok(t1.say === "Your work is still on this Mac" && t1.at === 0, "dirty+ahead: say, at 0");
ok(t1.next === "next hop: commit 3 files, then publish 12 commits", `dirty+ahead: next (${t1.next})`);
ok(same(vals(t1), ["3 files", "12 commits", "up to date"]) && same(t1.stops.map((s) => s.key), ["mac", "branch", "origin"]), "dirty+ahead: stops");
const t2 = tr({ kind: "ahead", n: 2 }, 0);
ok(t2.say === "Committed, not on origin yet" && t2.at === 1 && t2.next === "next hop: publish 2 commits", "clean+ahead: say, at 1, next");
const t3 = tr({ kind: "synced" }, 0);
ok(t3.say === "Everything is on origin" && t3.at === -1 && t3.next === "", "clean synced: all landed, no next hop");
ok(t3.stops.every((s) => s.tone === "ok"), "clean synced: every stop settled");
const t4 = tr({ kind: "behind", n: 3 }, 0);
ok(t4.stops[2].value === "3 new" && t4.stops[2].tone === "warn" && t4.at === 2 && t4.next === "next hop: pull 3 commits", "behind: origin 3 new, warn, at 2");
ok(tr({ kind: "publish", n: 2 }, 0, false).stops[2].value === "not pushed", "no upstream: origin not pushed");
ok(tr({ kind: "synced" }, 0, true, true).stops[2].tone === "dim", "unchecked: origin dim");
ok(tr({ kind: "ahead", n: 2 }, 4).stops[0].tone === "acc" && tr({ kind: "ahead", n: 120 }, 0).stops[1].value === "120 commits", "real counts, not the 99+ cap");
// dirty + behind: sentence, lit stop, next line and buttons agree; Commit stays reachable behind Pull.
const tdb = tr({ kind: "behind", n: 3 }, 2);
ok(tdb.at === 2 && tdb.say === "3 new on origin, your 2 files still here", `dirty+behind: say (${tdb.say})`);
ok(tdb.next === "next hop: pull 3 commits, then commit 2 files" && same(tdb.then, { verb: "Commit", n: 2 }), "dirty+behind: next, then");
ok(tr({ kind: "behind", n: 3 }, 0).then === null && tr({ kind: "ahead", n: 2 }, 4).then === null, "then only under a Pull with edits");
// landed but not everywhere ok: no action, yet the dim stop is not a tick
const tnu = tr({ kind: "publish", n: 0 }, 0, false);
ok(tnu.at === -1 && tnu.stops[2].value === "not pushed" && tnu.stops[2].tone === "dim" && tnu.stops[1].tone === "ok", "no upstream, nothing to publish: origin dim");
const tun = tr({ kind: "synced" }, 0, true, true);
ok(tun.at === -1 && tun.stops[2].value === "not checked" && tun.stops[2].tone === "dim", "synced, never fetched: origin dim");
// diverged: never a Pull (it can't fast-forward), and the next line says what a merge means.
const tdv = tr({ kind: "diverged", ahead: 231, behind: 18 }, 0);
ok(tdv.say === "You and origin both moved on" && tdv.at === 2, `diverged: say (${tdv.say})`);
ok(tdv.next === "a merge joins them; your 231 keep their ids", `diverged: next (${tdv.next})`);
const tdc = track(pipe({ kind: "diverged", ahead: 231, behind: 18 }, 0, true), { changed: 0, up: 231, down: 18 }, 19);
ok(tdc.next === "19 files changed on both sides", `diverged + clash: next (${tdc.next})`);
const tde = tr({ kind: "diverged", ahead: 2, behind: 3 }, 2);
ok(tde.at === 0 && tde.say === "You and origin both moved on" && tde.next === "next hop: commit 2 files, then merge 3" && tde.then === null,
  `diverged + edits: commit first, merge next (${tde.next})`);
console.log("gitpipe.check ok");
