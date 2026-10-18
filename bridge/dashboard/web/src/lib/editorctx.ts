/* Right-click edit rows for the CodeMirror boxes (the composer, the EDITOR body).

   CodeMirror's content is a contenteditable <div>, so the window listener's
   `input, textarea` exemption misses it and the dashboard menu took its place:
   Back / Forward / Reload where Cut / Copy / Paste belong. App builds the
   replacement rows, but the views belong to components, hence a registry keyed
   by the `data-ctx-id` the box's host carries ("composer", "editor").

   The types are structural, not @codemirror/view's: an EditorView fits them, and
   the check script runs under plain Node with a fake view and a fake navigator.
   Paste reads with clipboard.read() so a screenshot on the clipboard reaches the
   composer's attachments the way ⌘V does; WebKit may refuse a programmatic read,
   and "refused" is how the caller learns to point at ⌘V instead. */

export interface ViewLike {
  state: {
    doc: { length: number; sliceString(from: number, to: number): string };
    selection: { main: { from: number; to: number } };
  };
  dispatch(tr: { changes?: { from: number; to: number; insert?: string }; selection?: { anchor: number } }): void;
  focus(): void;
}

export interface EditorEntry {
  view: ViewLike;
  /** The open file, for "Send selection to chat"; undefined for the composer. */
  path?: () => string | undefined;
  /** Owner-specific rows: composer = attach | mention | clear; editor = format | symbol | find. */
  actions?: Record<string, () => void>;
}

const editors = new Map<string, EditorEntry>();

/** Returns the unregister. A box rebuilt under the same id replaces the old
 *  entry, and the old one's unregister then leaves the new one alone. */
export function registerEditor(id: string, entry: EditorEntry): () => void {
  editors.set(id, entry);
  return () => { if (editors.get(id) === entry) editors.delete(id); };
}

export function editorFor(id: string): EditorEntry | undefined {
  return editors.get(id);
}

export function selectedText(view: ViewLike): string {
  const { from, to } = view.state.selection.main;
  return view.state.doc.sliceString(from, to);
}

/** False when nothing is selected or the clipboard refused the write. */
export async function copySelection(view: ViewLike): Promise<boolean> {
  const text = selectedText(view);
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Deletes only after the copy landed, so a refused clipboard never loses text. */
export async function cutSelection(view: ViewLike): Promise<boolean> {
  if (!(await copySelection(view))) return false;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: "" } });
  return true;
}

export type PasteOutcome = "text" | "files" | "empty" | "refused";

function insert(view: ViewLike, text: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

export async function pasteInto(view: ViewLike, files?: (f: File[]) => void): Promise<PasteOutcome> {
  const cb = navigator.clipboard;
  if (typeof cb?.read !== "function") {
    if (typeof cb?.readText !== "function") return "refused";
    try {
      const text = await cb.readText();
      if (!text) return "empty";
      insert(view, text);
      return "text";
    } catch {
      return "refused";
    }
  }
  let items: ClipboardItems;
  try {
    items = await cb.read();
  } catch {
    return "refused";
  }
  const images: File[] = [];
  let text = "";
  for (const item of items) {
    const img = item.types.find((t) => t.startsWith("image/"));
    if (img && files) {
      const blob = await item.getType(img);
      images.push(new File([blob], `pasted.${img.slice(6) || "png"}`, { type: img }));
    } else if (!text && item.types.includes("text/plain")) {
      text = await (await item.getType("text/plain")).text();
    }
  }
  if (images.length) files!(images);
  if (text) { insert(view, text); return "text"; }
  return images.length ? "files" : "empty";
}
