/* The dashboard's shortcuts, short of the DOM. Keys are written in chord.ts's
   notation ("Ctrl+Alt+B"), where Ctrl is ⌘ on a Mac, so a key event matches by
   comparing chord(e) to the string. "Control" is the one exception: the Control
   key even on a Mac, for the keys whose ⌘ form macOS or the browser already owns
   (⌘Tab switches apps, ⌘R reloads). The handlers stay with the state they act
   on (App, the Ask cards); this module only names the keys and holds the logic
   worth checking — see shortcuts.check.ts. */

const MAC_GLYPH: Record<string, string> = {
  Ctrl: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↵", ArrowUp: "↑", ArrowDown: "↓",
};
const WORD: Record<string, string> = { Control: "Ctrl", ArrowUp: "↑", ArrowDown: "↓" };
// Apple prints modifiers as ⌃⌥⇧⌘ whatever order they were pressed in.
const MAC_ORDER = ["Control", "Alt", "Shift", "Ctrl"];

/** A shortcut as keycaps: one list of caps per alternative ("Alt+ArrowUp Alt+ArrowDown"). */
export function capsOf(keys: string, mac: boolean): string[][] {
  return keys.split(" ").map((alt) => {
    const parts = alt.split("+");
    const key = parts.pop()!;
    const mods = mac ? MAC_ORDER.filter((m) => parts.includes(m)) : parts;
    return [...mods, key].map((p) => (mac ? MAC_GLYPH[p] : WORD[p]) ?? p);
  });
}

/** ⌘J: the session after the one you're in, in NEEDS YOU's order (newest first,
 *  bridge/notices.py), round to the newest past the end; null when nothing else waits. */
export function nextNeed(ids: string[], current: string | null): string | null {
  const list = [...new Set(ids)];
  const next = list[(list.indexOf(current ?? "") + 1) % list.length];
  return next && next !== current ? next : null;
}

type AskQ = { multiSelect?: boolean };

/** The question an Ask card's ⌘1–9 act on: the first not done, -1 when all are.
 *  A pick-one question is done once answered; a pick-several one once ⌘↵ moved past it. */
export function askAt(qs: AskQ[], answered: boolean[], passed: Set<number>): number {
  return qs.findIndex((q, qi) => !(q.multiSelect ? passed.has(qi) : answered[qi]));
}

/** What ⌘↵ does on an Ask card: send once every question has an answer (as Send
 *  would), else move past the pick-several question the keys are on if it has
 *  picks (its index), else nothing. */
export function askEnter(qs: AskQ[], answered: boolean[], passed: Set<number>): "send" | number | null {
  if (qs.every((_, qi) => answered[qi])) return "send";
  const at = askAt(qs, answered, passed);
  return at >= 0 && qs[at].multiSelect && answered[at] ? at : null;
}

/** The nudge's count, per key: how often it was shown, NUDGES once the key was used. */
export type Nudges = Record<string, number>;
const NUDGES = 3;
export const nudgeDue = (n: Nudges, key: string) => (n[key] ?? 0) < NUDGES;
export const nudged = (n: Nudges, key: string): Nudges => ({ ...n, [key]: (n[key] ?? 0) + 1 });
export const keyUsed = (n: Nudges, key: string): Nudges => ({ ...n, [key]: NUDGES });

// ---- the table: what the ⌘/ sheet lists ------------------------------------------

export type Where = "Anywhere" | "Chat" | "Message box" | "Ask cards" | "Editor window";
export const WHERE: Where[] = ["Anywhere", "Chat", "Message box", "Ask cards", "Editor window"];
export interface Shortcut {
  keys: string;
  label: string;
  where: Where;
  /** A browser tab keeps it for itself (⌃Tab, ⌘N): it works in Mystical.app / .exe only. */
  app?: boolean;
}

export const SHORTCUTS = {
  palette: { keys: "Ctrl+K", label: "Command palette", where: "Anywhere" },
  sheet: { keys: "Ctrl+/", label: "Keyboard shortcuts", where: "Anywhere" },
  needs: { keys: "Ctrl+J", label: "Next thing that needs you", where: "Anywhere" },
  last: { keys: "Control+Tab", label: "Back to the last session", where: "Anywhere", app: true },
  newSession: { keys: "Ctrl+N", label: "New session in this project", where: "Anywhere", app: true },
  sidebar: { keys: "Ctrl+B", label: "Fold the sidebar", where: "Anywhere" },
  panel: { keys: "Ctrl+Alt+B", label: "Fold the right panel", where: "Anywhere" },
  rail: { keys: "Alt+1…9", label: "A right-rail tab", where: "Anywhere" },
  file: { keys: "Ctrl+P", label: "Find a file", where: "Anywhere" },
  search: { keys: "/", label: "Search the sessions", where: "Anywhere" },
  terminal: { keys: "Control+`", label: "The project's terminal", where: "Anywhere" },
  prompts: { keys: "Alt+ArrowUp Alt+ArrowDown", label: "Previous / next prompt", where: "Chat" },
  find: { keys: "Ctrl+F", label: "Search the chat", where: "Chat" },
  stop: { keys: "Ctrl+.", label: "Stop the turn", where: "Chat" },
  type: { keys: "A…Z", label: "Typing anywhere writes here", where: "Message box" },
  send: { keys: "Enter", label: "Send", where: "Message box" },
  newline: { keys: "Shift+Enter", label: "New line", where: "Message box" },
  history: { keys: "Control+R", label: "Past prompts", where: "Message box" },
  mention: { keys: "@", label: "Mention a file", where: "Message box" },
  commands: { keys: "/", label: "Commands and skills", where: "Message box" },
  pick: { keys: "Ctrl+1…9", label: "Pick an option", where: "Ask cards" },
  next: { keys: "Ctrl+Enter", label: "Next question, then send", where: "Ask cards" },
  editor: { keys: "Ctrl+Shift+P", label: "Every editor command, with its key", where: "Editor window" },
} satisfies Record<string, Shortcut>;

// ---- in the page ----------------------------------------------------------------

/** On a Mac, a Chrome tab as much as Mystical.app: Ctrl is drawn ⌘. */
export const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Does this key event press `keys`? */
export const pressed = (c: string, keys: string) => c === keys.replace(/\bControl\b/g, "Ctrl");

/** What a control with a shortcut carries: the key for its tooltip and nudge
 *  (ui/Tip's NativeTips reads data-key), and the same for a screen reader. */
export function keyAttrs(keys: string) {
  return { "data-key": keys, "aria-keyshortcuts": keys.replace(/\bCtrl\b/g, isMac() ? "Meta" : "Control") };
}

const FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** The cursor is in a text field: an input, a textarea or an editor. */
export const inField = (t: EventTarget | null) => !!(t as Element | null)?.closest?.(FIELDS);

/** The key is for the text field it was pressed in, not for a shortcut — except
 *  in the message box while it's empty (MarkdownInput marks it), where ⌥↑ or ⌥1
 *  would only type a symbol nobody starts a message with. */
export const typing = (t: EventTarget | null) =>
  inField(t) && !(t as Element).closest("[data-ctx-id='composer'][data-empty]");
