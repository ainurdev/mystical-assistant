// Run: node src/lib/headlook.check.ts  (from web/)
//
// SETTINGS ▸ CHAT ▸ HEADER: a stored look survives junk, and the fade's band
// clears the header it fades under.
import { HEAD_DEFAULT, fadeBand, fadeMask, toHead } from "./headlook.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(JSON.stringify(toHead(undefined)) === JSON.stringify(HEAD_DEFAULT), "nothing stored: the defaults");
ok(JSON.stringify(toHead("junk")) === JSON.stringify(HEAD_DEFAULT), "junk stored: the defaults");
const h = toHead({ shape: "bar", fade: "deep", glass: "solid", hide: true, last: false, search: false });
ok(h.shape === "bar" && h.fade === "deep" && h.glass === "solid" && h.hide && !h.last && !h.search, "a full look round-trips");
const bad = toHead({ shape: "round", fade: 3, glass: null, hide: "yes" });
ok(bad.shape === "pill" && bad.fade === "soft" && bad.glass === "frosted" && bad.hide === false, "bad values fall back one by one");
ok(bad.last && bad.search, "a missing switch keeps its default (on)");

ok(fadeBand("off", 44, true) === null, "OFF draws no band");
const pill = fadeBand("soft", 44, true)!;
ok(pill.from === 44 && pill.to > pill.from, "beside a pill: transparent down to its bottom, so nothing reads beside it");
const deep = fadeBand("deep", 44, true)!;
ok(deep.to > pill.to, "DEEP fades over more of the column than SOFT");
const bar = fadeBand("soft", 50, false)!;
ok(bar.from < 50 && bar.to <= 56, "under a full bar: the fade ends where a pinned WORK header starts (bottom + 6)");
ok(fadeMask(pill) === "linear-gradient(to bottom, transparent 44px, #000 68px)", "the mask is the band as a gradient");
