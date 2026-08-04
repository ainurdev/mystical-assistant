/* A keydown as a VS Code-notation chord ("Ctrl+Shift+F", "Shift+Alt+F", "F2"),
   so the EDITOR's command table can use one string as both the label it shows
   and the binding it matches. Kept pure and out of the component so it can be
   checked — see chord.check.ts. */

// Structurally what we need off a KeyboardEvent, so a check can pass a literal.
export interface ChordEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function chord(e: ChordEvent): string {
  const parts: string[] = [];
  // Cmd and Ctrl are the same binding — the bridge's keys are all VS Code's
  // Linux/Windows set, and a Mac user reaches for Cmd on every one of them.
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  /* The letter comes off `code`, not `key`: Alt+N on macOS reports key "˜", and
     a non-US layout can report anything at all. `key` still answers for F-keys,
     Escape and Enter, whose `code` is already the name we want. */
  const letter = /^Key([A-Z])$/.exec(e.code);
  parts.push(letter ? letter[1] : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join("+");
}
