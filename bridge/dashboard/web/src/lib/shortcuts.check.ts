// Run: node --experimental-strip-types src/lib/shortcuts.check.ts  (from web/)
//
// What a shortcut looks like and what it does, short of the DOM: the keycaps a
// tooltip, a ⌘K row and the ⌘/ sheet draw, ⌘J's walk through NEEDS YOU, an Ask
// card's ⌘1–9 / ⌘↵, and the nudge's count.
import { askAt, askEnter, capsOf, keyUsed, nextNeed, nudged, nudgeDue } from "./shortcuts.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const same = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

// ---- keycaps ------------------------------------------------------------------
same(capsOf("Ctrl+B", true), [["⌘", "B"]], "Ctrl is ⌘ on a Mac");
same(capsOf("Ctrl+B", false), [["Ctrl", "B"]], "and Ctrl elsewhere");
same(capsOf("Control+Tab", true), [["⌃", "Tab"]], "Control stays ⌃ on a Mac (⌘Tab is the app switcher)");
same(capsOf("Control+R", false), [["Ctrl", "R"]], "Control is plain Ctrl elsewhere");
same(capsOf("Ctrl+Alt+B", true), [["⌥", "⌘", "B"]], "Mac modifiers in Apple's order: ⌃⌥⇧⌘");
same(capsOf("Ctrl+Alt+B", false), [["Ctrl", "Alt", "B"]], "the written order elsewhere");
same(capsOf("Alt+ArrowUp Alt+ArrowDown", true), [["⌥", "↑"], ["⌥", "↓"]], "two alternatives, side by side");
same(capsOf("Shift+Enter", true), [["⇧", "↵"]], "Shift and Enter as glyphs on a Mac");
same(capsOf("Ctrl+Enter", false), [["Ctrl", "Enter"]], "and as words elsewhere");
same(capsOf("Alt+1…9", true), [["⌥", "1…9"]], "a range is one cap");
same(capsOf("/", true), [["/"]], "a bare key");
same(capsOf("Ctrl+.", true), [["⌘", "."]], "punctuation stays itself");

// ---- ⌘J: the sessions in NEEDS YOU, newest first (bridge/notices.py needs) ----
same(nextNeed(["B", "A"], "C"), "B", "from a session nobody waits in: the newest");
same(nextNeed(["B", "A"], null), "B", "with no session open: the newest");
same(nextNeed(["B", "A", "D"], "B"), "A", "from one of them: the one after it");
same(nextNeed(["B", "A", "D"], "D"), "B", "past the oldest: back round to the newest");
same(nextNeed(["B", "B", "A"], "B"), "A", "a session waiting twice counts once");
same(nextNeed(["B"], "B"), null, "only the session you're in: nothing else");
same(nextNeed([], "C"), null, "nothing waiting: nothing");

// ---- Ask cards: ⌘1–9 act on the first question not done, ⌘↵ moves on or sends ----
const qs = [{ multiSelect: false }, { multiSelect: true }, { multiSelect: false }];
const none = new Set<number>();
same(askAt(qs, [false, false, false], none), 0, "keys start on the first question");
same(askAt(qs, [true, false, false], none), 1, "a pick-one question is done once it has an answer");
same(askAt(qs, [true, true, false], none), 1, "a pick-several one keeps the keys while you pick more");
same(askAt(qs, [true, true, false], new Set([1])), 2, "until ⌘↵ moves past it");
same(askAt(qs, [true, true, true], new Set([1])), -1, "all done: no question takes the keys");
same(askEnter(qs, [false, false, false], none), null, "⌘↵ on an unanswered pick-one question does nothing");
same(askEnter(qs, [true, false, false], none), null, "nor on a pick-several one with nothing picked");
same(askEnter(qs, [true, true, false], none), 1, "a pick-several one with picks: ⌘↵ moves past it");
same(askEnter(qs, [true, true, true], none), "send", "every question answered: ⌘↵ sends, like Send");
same(askEnter([{ multiSelect: false }], [true], none), "send", "a one-question card: pick, then ⌘↵ sends");

// ---- the nudge: three times per key at most, never once the key was used ----
const twice = nudged(nudged({}, "Alt+3"), "Alt+3");
ok(nudgeDue({}, "Alt+3"), "a key never nudged is due");
ok(nudgeDue(twice, "Alt+3"), "after two nudges, a third is still due");
ok(!nudgeDue(nudged(twice, "Alt+3"), "Alt+3"), "after three, it stops");
ok(!nudgeDue(keyUsed({}, "Ctrl+B"), "Ctrl+B"), "a key you pressed is never nudged again");
ok(nudgeDue(keyUsed(twice, "Ctrl+B"), "Alt+3"), "each key counts on its own");

console.log("\nall shortcut checks passed");
