// Run: node bridge/dashboard/web/src/lib/seenshots.check.ts
// The browser's memory, in a Map: the store reads it on import and writes it on
// every mark, so each scenario stubs it BEFORE importing a fresh module instance
// (the ?query makes the loader hand back a new one; built as a string so tsc,
// which can't resolve a query, leaves it alone).
const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  },
});

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

// A browser that already holds a seen set and a birth stamp.
mem.set("hud-shots-seen", JSON.stringify(["/u/kept.png"]));
mem.set("hud-shots-since", "1000");
const fresh = (tag: string) => import(`./seenshots.ts?${tag}`);
const a = await fresh("a");
ok(!a.shotUnseen("/u/kept.png", 2000), "a shot the browser remembers is seen");
ok(a.shotUnseen("/u/new.png", 2000), "a shot taken after the store was born, not yet marked, is unseen");
ok(!a.shotUnseen("/u/new.png", 999), "a shot older than the store counts as seen — old turns don't all light up");
ok(!a.shotUnseen("/u/new.png", undefined), "a shot with no clock counts as seen");
a.markShotSeen("/u/new.png");
ok(!a.shotUnseen("/u/new.png", 2000), "marking a shot makes it seen");
ok(JSON.parse(mem.get("hud-shots-seen")!).includes("/u/new.png"), "a mark is written to the browser");
for (let i = 0; i < 2100; i++) a.markShotSeen(`/u/s${i}.png`);
const stored: string[] = JSON.parse(mem.get("hud-shots-seen")!);
ok(stored.length <= 2000, `the set is capped (${stored.length})`);
ok(stored.includes("/u/s2099.png") && !stored.includes("/u/kept.png"), "the cap drops the oldest marks first");

// A browser that has never seen the store: it is born now, and stamps that.
mem.clear();
const before = Date.now() / 1000;
const b = await fresh("b");
const since = Number(mem.get("hud-shots-since"));
ok(since >= before - 1 && since <= Date.now() / 1000 + 1, "first load stamps the birth in epoch seconds");
ok(!b.shotUnseen("/u/earlier.png", before - 60), "a shot from before the first load is seen");
ok(b.shotUnseen("/u/later.png", before + 60), "a shot from after it is unseen");

// Opening a chat stamps it: the sidebar tag counts only shots after the stamp.
mem.clear();
mem.set("hud-shots-opened", JSON.stringify({ old: Date.now() / 1000 - 2 * 86400 }));
const c = await fresh("c");
ok(c.chatOpenedAt("never") === 0, "a chat never opened has no stamp");
const t0 = Date.now() / 1000;
c.markChatOpened("s1");
ok(c.chatOpenedAt("s1") >= t0 - 1, "opening a chat stamps it now");
const opened = JSON.parse(mem.get("hud-shots-opened")!);
ok(opened.s1 >= t0 - 1 && !("old" in opened), "the stamp is written, and one older than the tag's day goes");
console.log("seenshots: all ok");
