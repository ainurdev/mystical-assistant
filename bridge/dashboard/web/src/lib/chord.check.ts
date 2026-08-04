// Run: node --experimental-strip-types src/lib/chord.check.ts  (from web/)
//
// The EDITOR matches key events by comparing this string to the one printed in
// the command palette. Get the shape wrong and a binding silently stops firing
// while the palette still advertises it.
import { chord, type ChordEvent } from "./chord.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: string, want: string, what: string) =>
  ok(got === want, `${what} — got ${got}`);

const ev = (e: Partial<ChordEvent>): ChordEvent =>
  ({ key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...e });

eq(chord(ev({ key: "p", code: "KeyP", ctrlKey: true })), "Ctrl+P", "Ctrl-P");
eq(chord(ev({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+F", "Ctrl-Shift-F");
eq(chord(ev({ key: "F", code: "KeyF", shiftKey: true, altKey: true })), "Shift+Alt+F", "format's Shift-Alt-F");
eq(chord(ev({ key: "F2", code: "F2" })), "F2", "a bare F-key");
eq(chord(ev({ key: "F4", code: "F4", ctrlKey: true })), "Ctrl+F4", "close editor's Ctrl-F4");
eq(chord(ev({ key: "Escape", code: "Escape" })), "Escape", "a named key keeps its name");

// The two reasons the letter comes off `code` rather than `key`.
eq(chord(ev({ key: "˜", code: "KeyN", altKey: true })), "Alt+N", "macOS Alt-N, whose key is a dead char");
eq(chord(ev({ key: "н", code: "KeyN", altKey: true })), "Alt+N", "a non-Latin layout still binds by position");

// Cmd is Ctrl, so a Mac gets the same bindings without a second table.
eq(chord(ev({ key: "s", code: "KeyS", metaKey: true })), "Ctrl+S", "Cmd-S is Ctrl-S");
eq(chord(ev({ key: "s", code: "KeyS", ctrlKey: true, metaKey: true })), "Ctrl+S", "both together stay one Ctrl");

// Modifier order is fixed — the strings in the command table are written this way.
eq(chord(ev({ key: "o", code: "KeyO", ctrlKey: true, shiftKey: true, altKey: true })), "Ctrl+Shift+Alt+O",
  "Ctrl before Shift before Alt");

console.log("\nall chord checks passed");
