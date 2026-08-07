// Run: node --experimental-strip-types src/lib/editorprefs.check.ts  (from web/)
//
// Prefs are read on every editor mount and a bad merge silently reverts someone's
// settings — or worse, `formatOnSave` flips on and rewrites a file they didn't
// want reformatted. Pin the defaults, the merge, and the corrupt-storage path.
import { DEFAULT_PREFS, clampFont, mergePrefs } from "./editorprefs.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

eq(mergePrefs(null), DEFAULT_PREFS, "no stored prefs gives the defaults");
eq(mergePrefs("not json"), DEFAULT_PREFS, "corrupt storage gives the defaults");
eq(mergePrefs('{"wordWrap":true}').wordWrap, true, "a stored field wins");
eq(mergePrefs('{"wordWrap":true}').formatOnSave, false, "an absent field falls back");
eq(mergePrefs('{"fontSize":"14"}').fontSize, DEFAULT_PREFS.fontSize,
  "a wrongly typed field falls back");
eq(mergePrefs('{"nope":1}'), DEFAULT_PREFS, "an unknown field is dropped");

eq(mergePrefs(null).vim, false, "vim mode is off by default");
eq(mergePrefs('{"vim":true}').vim, true, "a stored vim flag wins");
eq(mergePrefs('{"vim":"yes"}').vim, false, "a wrongly typed vim flag falls back");

// Font size is written into a CSS length — an out-of-range number would make the
// buffer unreadable with no way back except clearing localStorage.
eq(clampFont(11), 11, "an in-range size is kept");
eq(clampFont(2), 9, "too small clamps to the floor");
eq(clampFont(99), 22, "too large clamps to the ceiling");
eq(clampFont(Number.NaN), DEFAULT_PREFS.fontSize, "NaN falls back to the default");
