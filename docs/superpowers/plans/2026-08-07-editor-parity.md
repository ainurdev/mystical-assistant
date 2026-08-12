# Editor Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six gaps that still make someone leave the dashboard and open VS Code — lost undo history, no editor settings, no vim mode, an unusable phone keyboard, no diff-against-HEAD, and no IntelliSense.

**Architecture:** The editor stays CodeMirror 6 (settled 2026-08-03, see `docs/superpowers/` history and the `editor-direction-codemirror` memory). Everything heavy runs on the bridge, where the repo, its `node_modules`, its formatters and its language servers already live; the browser only renders. Tasks 1–4 are self-contained frontend changes with no new backend. Task 5 adds one read-only git endpoint. Task 6 adds a websocket proxy that mirrors the existing terminal websocket almost line for line.

**Tech Stack:** CodeMirror 6, React 19 + TypeScript (Vite), Python 3 stdlib `http.server` (`bridge/dashboard/server.py`), hand-rolled websockets (`bridge/wsutil.py`).

## Global Constraints

- **No new runtime dependency where an installed one works.** New deps in this plan, and only these: `@replit/codemirror-vim` (Task 3), `@codemirror/merge` (Task 5), `@marimo-team/codemirror-languageserver` + `@open-rpc/client-js` (Task 6).
- **Do not restart the bridge.** It runs a snapshot of the code from launch; a restart kills the session hosting this work. Backend changes (Tasks 5, 6) are verified by the pytest-style test files, not by hitting the live server. See the `bridge-child-session-sigkill` memory.
- **Dashboard builds are not live-reloaded.** The bridge serves a prebuilt `dist` from its LAUNCH checkout, not from a worktree. See the `dashboard-web-build-deploy` memory before claiming a UI change is visible.
- **Websocket endpoints must go through `_ws_authorized`** (`bridge/dashboard/server.py:51`) — Host allow-list + Origin allow-list + `DASH_TOKEN`. Websockets bypass same-origin policy; skipping the Origin check is a CSWSH hole.
- **Frontend pure logic gets a `.check.ts` next to it**, run with `node --experimental-strip-types src/lib/<name>.check.ts` from `bridge/dashboard/web/`. See `src/lib/tabs.check.ts` for the house style (`ok`/`eq` helpers, no framework).
- **Backend logic gets a `tests/test_*.py`**, run with `python tests/test_<name>.py`. See `tests/test_files_endpoints.py` for the `Handler.__new__` trick used to drive endpoints without a socket.
- Commit after every task. No `Co-Authored-By` lines.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `bridge/dashboard/web/src/components/hud/EditorTab.tsx` | modify | The editor. Touched by every task. Already 1121 lines — Tasks 2, 5, 6 push logic out into `lib/` rather than growing it. |
| `bridge/dashboard/web/src/lib/editorprefs.ts` | create | Editor preference load/save/merge. Pure, testable. |
| `bridge/dashboard/web/src/lib/editorprefs.check.ts` | create | Check for the above. |
| `bridge/dashboard/web/src/lib/lsp.ts` | create | Builds the CodeMirror LSP extension for a path; owns the websocket URL and language-id mapping. |
| `bridge/dashboard/web/src/lib/lsp.check.ts` | create | Check for the language-id mapping and URI building. |
| `bridge/miniapp/web/src/components/KeyRow.tsx` | create | The phone symbol row above the keyboard. |
| `bridge/miniapp/web/src/components/CodeEditor.tsx` | modify | Hand its `EditorView` back to the route so `KeyRow` can dispatch into it. |
| `bridge/miniapp/web/src/routes/files.tsx` | modify | Mount `KeyRow`; wire Ctrl-S/Cmd-S. |
| `bridge/git.py` | modify | `show_head()` — a file's content at HEAD, for the diff base. |
| `bridge/lsp.py` | create | Language-server process registry + LSP stdio framing codec. Mirrors `bridge/terminals.py`. |
| `bridge/dashboard/server.py` | modify | `/local/files/head`, `/local/lsp/available`, `/local/lsp` (websocket). |
| `bridge/dashboard/web/src/api.ts` | modify | Client methods for the new endpoints. |
| `tests/test_lsp.py` | create | The LSP stdio framing codec + server availability. |
| `tests/test_files_endpoints.py` | modify | `/local/files/head` and `/local/lsp/available` wiring. |

---

### Task 1: Per-tab editor state (undo survives a tab switch)

Today `EditorTab.tsx:386-391` destroys the `EditorView` on every tab switch and stashes only the document text. Undo history, fold state, and cursor position die with it. A `CodeMirror` `EditorState` is an immutable value that holds all three, and a new `EditorView` can be constructed from one directly — so keeping the state instead of the string fixes all of it.

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/EditorTab.tsx:254`, `:333-393`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `bufs` map entry shape `{ meta: FileContent; text: string; base: string; state?: EditorState }`, and a local `const cachedState: EditorState | undefined` in the mount effect. Tasks 2, 5 and 6 add extensions to the same `EditorState.create` call; Tasks 5 and 6 both branch on `cachedState`, because a compartment's contents live *in* the state — reconfiguring a state that already carries the extension would duplicate it (for Task 6, that means a second websocket on every tab switch).

- [ ] **Step 1: Widen the buffer cache entry**

In `EditorTab.tsx`, change the `bufs` ref declaration (currently line 254):

```tsx
  // One entry per open tab: the load result, the buffer text as it was when we
  // switched away, the on-disk content, and the full CodeMirror state. Switching
  // tabs tears the view down, so without `state` every switch would lose the
  // undo history, the folds and the cursor along with any unsaved edits.
  const bufs = useRef(new Map<string, { meta: FileContent; text: string; base: string; state?: EditorState }>());
```

`EditorState` is already imported at line 7.

- [ ] **Step 2: Reuse the cached state when mounting**

In the "(Re)build the CodeMirror view" effect, replace the `const state = EditorState.create({...})` assignment's *use* — keep the `EditorState.create(...)` call exactly as it is but assign it to `fresh`, then pick:

```tsx
    const fresh = EditorState.create({
      /* …every existing extension, unchanged… */
    });
    // A tab we've been in before comes back with its history, folds and cursor —
    // and with whatever its compartments already held, which is why Tasks 5 and 6
    // check `cachedState` before configuring one again.
    const cachedState = bufs.current.get(open)?.state;
    const state = cachedState ?? fresh;
```

- [ ] **Step 3: Stash the state on the way out**

In the same effect's cleanup (currently lines 386-391):

```tsx
    return () => {
      // Stash the buffer on the way out so switching tabs keeps unsaved edits,
      // the undo history and the cursor.
      const b = bufs.current.get(open);
      if (b) { b.text = view.state.doc.toString(); b.state = view.state; }
      view.destroy(); viewRef.current = null;
    };
```

- [ ] **Step 4: Drop the stale state after a save**

`save()` replaces the document via `replaceDoc` before writing, so the live view's state is already correct — but `closeTab` and `remapTabs` delete or move whole entries and need no change. The one place that *writes* `b.text` without touching `b.state` is `save()` (line ~423). Update it so the two never disagree:

```tsx
        const b = bufs.current.get(open);
        if (b) { b.text = content; b.base = content; b.state = v.state; }
```

- [ ] **Step 5: Verify by hand**

Build and load the dashboard (see the `dashboard-web-build-deploy` memory for how — do **not** restart the bridge):

```bash
cd bridge/dashboard/web && npx tsc --noEmit && npx vite build
```

Then in the browser: open file A, type three characters, open file B from the explorer, click back to A's tab, press Ctrl-Z three times. Expected: all three characters are undone and the cursor is where you left it. Before this task, Ctrl-Z did nothing.

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/EditorTab.tsx
git commit -m "fix(editor): keep undo history and cursor across tab switches"
```

---

### Task 2: Editor preferences, exposed through the command palette

VS Code's most-used editor settings are `formatOnSave`, `wordWrap` and font size. There is no settings UI to build: the `CMDS` table at `EditorTab.tsx:616` already drives both the Ctrl-Shift-P palette and the key handler, so a preference becomes a toggle command with no new chrome — which is also how VS Code itself exposes word wrap (Alt+Z) and font size.

**Files:**
- Create: `bridge/dashboard/web/src/lib/editorprefs.ts`
- Create: `bridge/dashboard/web/src/lib/editorprefs.check.ts`
- Modify: `bridge/dashboard/web/src/components/hud/EditorTab.tsx`

**Interfaces:**
- Consumes: the `bufs` entry shape and the `EditorState.create` extension list from Task 1.
- Produces: `EditorPrefs`, `DEFAULT_PREFS`, `KEY`, `clampFont(n)`, `mergePrefs(raw)`, `loadPrefs()`, `savePrefs(p)`. Task 3 adds a `vim: boolean` field to `EditorPrefs`; Task 6 adds `lsp: boolean`.

- [ ] **Step 1: Write the failing check**

Create `bridge/dashboard/web/src/lib/editorprefs.check.ts`:

```ts
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

// Font size is written into a CSS length — an out-of-range number would make the
// buffer unreadable with no way back except clearing localStorage.
eq(clampFont(11), 11, "an in-range size is kept");
eq(clampFont(2), 9, "too small clamps to the floor");
eq(clampFont(99), 22, "too large clamps to the ceiling");
eq(clampFont(Number.NaN), DEFAULT_PREFS.fontSize, "NaN falls back to the default");
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd bridge/dashboard/web && node --experimental-strip-types src/lib/editorprefs.check.ts
```

Expected: `Cannot find module './editorprefs.ts'`.

- [ ] **Step 3: Write the module**

Create `bridge/dashboard/web/src/lib/editorprefs.ts`:

```ts
/* Editor preferences — the three VS Code settings people actually change, kept
   per browser like every other HUD pref (see lib/prefs.ts). No settings panel:
   they're toggle commands in the editor's own Ctrl-Shift-P palette, which is
   where VS Code puts word wrap and font size too. */

export interface EditorPrefs {
  formatOnSave: boolean;
  wordWrap: boolean;
  fontSize: number;   // px
}

export const DEFAULT_PREFS: EditorPrefs = {
  formatOnSave: false,
  wordWrap: false,
  fontSize: 12,       // matches the crtTheme default in EditorTab
};

export const KEY = "hud-editor-prefs";
const FONT_MIN = 9;
const FONT_MAX = 22;

/** Keep the font inside a range the buffer stays readable at — the only way out
 *  of a bad value is clearing localStorage. */
export function clampFont(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PREFS.fontSize;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

/** Defaults overlaid with whatever survived in storage. Unknown keys are dropped
 *  and wrongly typed ones fall back, so an old or hand-edited value can't put the
 *  editor in a state with no UI to escape it. */
export function mergePrefs(raw: string | null): EditorPrefs {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch { /* corrupt — defaults */ }
  return {
    formatOnSave: typeof stored.formatOnSave === "boolean" ? stored.formatOnSave : DEFAULT_PREFS.formatOnSave,
    wordWrap: typeof stored.wordWrap === "boolean" ? stored.wordWrap : DEFAULT_PREFS.wordWrap,
    fontSize: typeof stored.fontSize === "number" ? clampFont(stored.fontSize) : DEFAULT_PREFS.fontSize,
  };
}

export function loadPrefs(): EditorPrefs {
  try { return mergePrefs(localStorage.getItem(KEY)); } catch { return DEFAULT_PREFS; }
}

export function savePrefs(p: EditorPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run the check to confirm it passes**

```bash
cd bridge/dashboard/web && node --experimental-strip-types src/lib/editorprefs.check.ts
```

Expected: ten `ok - …` lines, exit 0.

- [ ] **Step 5: Wire the prefs into the editor**

In `EditorTab.tsx`, add the import and the state near the other `useState` calls:

```tsx
import { clampFont, loadPrefs, savePrefs, type EditorPrefs } from "../../lib/editorprefs";
```

```tsx
  const [prefs, setPrefs] = useState<EditorPrefs>(loadPrefs);
  useEffect(() => { savePrefs(prefs); }, [prefs]);
```

Add two compartments next to `langComp` (line 138):

```tsx
// Reconfigured live when the prefs change, so a toggle doesn't rebuild the buffer.
const wrapComp = new Compartment();
const fontComp = new Compartment();
```

Add them to the extension list inside `EditorState.create` (after `crtTheme`):

```tsx
        wrapComp.of(prefs.wordWrap ? EditorView.lineWrapping : []),
        fontComp.of(EditorView.theme({ "&": { fontSize: `${prefs.fontSize}px` } })),
```

Because the values are needed in two places, build them once at module scope:

```tsx
const wrapExt = (on: boolean) => (on ? EditorView.lineWrapping : []);
const fontExt = (px: number) => EditorView.theme({ "&": { fontSize: `${px}px` } });
```

and use them in the extension list above (`wrapComp.of(wrapExt(prefs.wordWrap))`, `fontComp.of(fontExt(prefs.fontSize))`).

Reconfigure on change, after the mount effect — this reaches the focused buffer:

```tsx
  // Prefs change far more often than files do — reconfigure in place rather than
  // rebuilding the buffer, which would drop the cursor.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: [
      wrapComp.reconfigure(wrapExt(prefs.wordWrap)),
      fontComp.reconfigure(fontExt(prefs.fontSize)),
    ] });
  }, [prefs.wordWrap, prefs.fontSize]);
```

That effect alone is **not** enough. A tab that wasn't focused when the pref changed comes back through `cachedState`, which still carries the compartment contents from its last mount — so it would silently disagree with the palette label until it happened to be focused during some future toggle. Re-sync on every mount, the way `langComp` already does inside the same effect. Add this immediately after `view.focus()`:

```tsx
    // A restored tab carries the compartments from its last mount, so a pref
    // toggled while another tab was focused never reached it. Re-sync on mount —
    // same reason langComp is dispatched here rather than baked into `fresh`.
    view.dispatch({ effects: [
      wrapComp.reconfigure(wrapExt(prefs.wordWrap)),
      fontComp.reconfigure(fontExt(prefs.fontSize)),
    ] });
```

- [ ] **Step 6: Add format-on-save**

`format()` returns after swapping the buffer text; `save()` reads the buffer fresh. So format-on-save is `await format()` before reading. Change the top of `save()`:

```tsx
  async function save() {
    const v = viewRef.current;
    if (!v || !open || saving) return;
    // Claim the guard before the first await, not after: `format()` is a round
    // trip to the bridge, and a second Ctrl-S during it would sail past a guard
    // that hasn't been set yet, no-op inside format()'s own `fmting` guard, then
    // write the *unformatted* buffer in a race with this call's write.
    setSaving(true);
    // Format first when asked — format() swaps the buffer, and the read below
    // picks the result up. A formatter failure only flashes; the save still runs.
    if (prefs.formatOnSave && meta?.formatter !== false) await format();
    const raw = v.state.doc.toString();
    /* …unchanged from here, except that the later `setSaving(true)` is now
       redundant and must be deleted — the `try`/`finally` around the write and
       its `setSaving(false)` stay exactly as they are… */
```

- [ ] **Step 7: Add the toggle commands**

Append to the `CMDS` array in `EditorTab.tsx`:

```tsx
    { label: `Format on Save — ${prefs.formatOnSave ? "on" : "off"}`,
      run: () => setPrefs((p) => ({ ...p, formatOnSave: !p.formatOnSave })) },
    { label: `Toggle Word Wrap — ${prefs.wordWrap ? "on" : "off"}`, key: "Alt+Z",
      run: () => setPrefs((p) => ({ ...p, wordWrap: !p.wordWrap })) },
    { label: "Increase Font Size", key: "Ctrl+=", alt: "Ctrl++",
      run: () => setPrefs((p) => ({ ...p, fontSize: clampFont(p.fontSize + 1) })) },
    { label: "Decrease Font Size", key: "Ctrl+-",
      run: () => setPrefs((p) => ({ ...p, fontSize: clampFont(p.fontSize - 1) })) },
```

`Alt+Z` matches VS Code. `Ctrl+=` / `Ctrl+-` are the browser's zoom keys — the existing `keyRef` handler calls `preventDefault()` on any matched chord (line 678), so they are captured, and zooming the whole page was never what was wanted inside the editor anyway.

- [ ] **Step 8: Verify by hand**

Build, reload, then: `Ctrl-Shift-P` → "Toggle Word Wrap" on a long line — the line wraps and the palette entry now reads `— on`. `Ctrl-=` twice — the buffer text grows. Reload the page — both settings survive. Turn "Format on Save" on, mangle the indentation of a `.ts` file, `Ctrl-S` — the file is formatted and written in one action.

- [ ] **Step 9: Commit**

```bash
git add bridge/dashboard/web/src/lib/editorprefs.ts \
        bridge/dashboard/web/src/lib/editorprefs.check.ts \
        bridge/dashboard/web/src/components/hud/EditorTab.tsx
git commit -m "feat(editor): format-on-save, word wrap and font size as palette toggles"
```

---

### Task 3: Real vim mode, retiring the fake `:` bar

The editor's footer has a `:` input that understands exactly `w`, `wq`, `x`, `fmt` (`onCmdKey`, `EditorTab.tsx:811`). `@replit/codemirror-vim` (6.4.0, released 2026-07-29; the package Replit, Observable and JupyterLab all use) gives the real thing — `:w`, `:%s///g`, `dw`, `ciw`, macros — for two lines, and makes the fake bar dead weight.

**Files:**
- Modify: `bridge/dashboard/web/package.json`
- Modify: `bridge/dashboard/web/src/lib/editorprefs.ts`
- Modify: `bridge/dashboard/web/src/lib/editorprefs.check.ts`
- Modify: `bridge/dashboard/web/src/components/hud/EditorTab.tsx`

**Interfaces:**
- Consumes: `EditorPrefs`, `mergePrefs`, `DEFAULT_PREFS` from Task 2.
- Produces: `EditorPrefs.vim: boolean`.

- [ ] **Step 1: Install the dependency**

```bash
cd bridge/dashboard/web && npm install @replit/codemirror-vim
```

- [ ] **Step 2: Extend the prefs check first**

Add to `editorprefs.check.ts`, before the font block:

```ts
eq(mergePrefs(null).vim, false, "vim mode is off by default");
eq(mergePrefs('{"vim":true}').vim, true, "a stored vim flag wins");
eq(mergePrefs('{"vim":"yes"}').vim, false, "a wrongly typed vim flag falls back");
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd bridge/dashboard/web && node --experimental-strip-types src/lib/editorprefs.check.ts
```

Expected: `FAIL: vim mode is off by default` (the field is `undefined`).

- [ ] **Step 4: Add the field**

In `editorprefs.ts`, add `vim: boolean;` to the `EditorPrefs` interface, `vim: false,` to `DEFAULT_PREFS`, and to `mergePrefs`'s return:

```ts
    vim: typeof stored.vim === "boolean" ? stored.vim : DEFAULT_PREFS.vim,
```

- [ ] **Step 5: Run the check to confirm it passes**

```bash
cd bridge/dashboard/web && node --experimental-strip-types src/lib/editorprefs.check.ts
```

Expected: all `ok - …`, exit 0.

- [ ] **Step 6: Wire vim into the editor**

In `EditorTab.tsx`:

```tsx
import { Vim, vim } from "@replit/codemirror-vim";
```

Add a compartment beside `wrapComp`:

```tsx
const vimComp = new Compartment();
```

Vim's keymap has to sit **above** everything, including the `Prec.highest` save binding — otherwise `Esc` and the operator-pending keys leak. Put it first in the extension list inside `EditorState.create`:

```tsx
        // Above even the Ctrl-S binding: vim owns Escape and every bare key while
        // it's on, and a keymap below it would swallow operator-pending input.
        vimComp.of(prefs.vim ? vim() : []),
```

Reconfigure on toggle, in the same effect as `wrapComp`:

```tsx
      vimComp.reconfigure(prefs.vim ? vim() : []),
```

- [ ] **Step 7: Teach vim the two project commands**

`:w` in vim mode must save through the same path as `Ctrl-S`, not vim's no-op. Register once, at module scope below the compartments:

```tsx
/* `:w` and `:fmt` route through the editor's own save/format so .editorconfig
   cleanup and the bridge formatter still run. Registered against refs, so they
   always hit the current file. */
const vimSaveRef = { current: () => {} };
const vimFmtRef = { current: () => {} };
Vim.defineEx("write", "w", () => vimSaveRef.current());
Vim.defineEx("fmt", "fmt", () => vimFmtRef.current());
```

And keep them current next to the existing `saveRef.current = …` assignment:

```tsx
  vimSaveRef.current = () => { void save(); };
  vimFmtRef.current = () => { void format(); };
```

- [ ] **Step 8: Add the toggle command and delete the fake bar**

Append to `CMDS`:

```tsx
    { label: `Vim Mode — ${prefs.vim ? "on" : "off"}`,
      run: () => setPrefs((p) => ({ ...p, vim: !p.vim })) },
```

Then delete the `:` command bar — the `<span>{":"}</span>` and `<input value={cmd} …>` at the end of the footer (`EditorTab.tsx:1073-1076`), the `onCmdKey` function (`:811-818`), and the `const [cmd, setCmd] = useState("")` state (`:224`). Removing the state and handler is required: they are orphaned by this change and nothing else references them.

- [ ] **Step 9: Verify by hand**

Build and reload. `Ctrl-Shift-P` → "Vim Mode" → the buffer shows a block cursor. Type `ciw`, replace a word, `Esc`, `:w` + Enter — the status bar flashes `wrote <path>`. `Ctrl-Shift-P` → "Vim Mode" again — normal insert behaviour returns and `Ctrl-S` still saves. Reload — vim mode is still on.

- [ ] **Step 10: Commit**

```bash
git add bridge/dashboard/web/package.json bridge/dashboard/web/package-lock.json \
        bridge/dashboard/web/src/lib/editorprefs.ts \
        bridge/dashboard/web/src/lib/editorprefs.check.ts \
        bridge/dashboard/web/src/components/hud/EditorTab.tsx
git commit -m "feat(editor): real vim mode, replacing the four-command : bar"
```

---

### Task 4: Mini App symbol row and save shortcut

The Mini App buffer (`bridge/miniapp/web/src/components/CodeEditor.tsx`) is deliberately bare, and that is right — but on a phone keyboard `{`, `}`, `[`, `]`, `<`, `>`, `|`, `` ` `` and Tab each cost two or three keyboard-layer switches. Every serious mobile code editor answers this the same way: a scrollable symbol row pinned above the keyboard. This is the single biggest phone-side improvement in the plan and it needs no backend.

**Files:**
- Create: `bridge/miniapp/web/src/components/KeyRow.tsx`
- Modify: `bridge/miniapp/web/src/components/CodeEditor.tsx`
- Modify: `bridge/miniapp/web/src/routes/files.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks — the Mini App is a separate bundle.
- Produces: `KeyRow({ view })` where `view: EditorView | null`; `CodeEditor` gains an `onView?: (v: EditorView | null) => void` prop, called with the view on mount and `null` on unmount.

- [ ] **Step 1: Hand the view out of CodeEditor**

In `CodeEditor.tsx`, add the prop and call it from the existing effect:

```tsx
export default function CodeEditor({
  path,
  initial,
  onChange,
  onView,
}: {
  path: string;
  initial: string;
  onChange: (text: string) => void;
  onView?: (v: EditorView | null) => void;
}) {
```

At the end of the effect, just before the existing `return () => view.destroy();`:

```tsx
    onView?.(view);
    return () => { onView?.(null); view.destroy(); };
```

`onView` must be excluded from the dep array — it is already suppressed by the `eslint-disable-next-line react-hooks/exhaustive-deps` on the line below, and the route below passes a `useState` setter, which is stable.

- [ ] **Step 2: Write the symbol row**

Create `bridge/miniapp/web/src/components/KeyRow.tsx`:

```tsx
import type { EditorView } from "@codemirror/view";

/* The row above the phone keyboard. Every one of these characters costs two or
   three layer switches on an iOS/Android keyboard, which is what makes editing
   code on a phone miserable — this is the whole fix.

   Pointer-down is prevented on every button: without it the tap blurs the
   buffer, the keyboard drops, and the insert lands nowhere. */

// Ordered by how often they're actually typed in source, not by ASCII.
const KEYS = [
  "⇥", "{", "}", "(", ")", "[", "]", "<", ">", "=", ":", ";", ".", ",",
  "\"", "'", "`", "/", "\\", "|", "&", "!", "?", "-", "_", "+", "*", "#", "$", "@", "~",
];

// The tab key inserts the project's indent; everything else is itself.
const TEXT: Record<string, string> = { "⇥": "  " };

export default function KeyRow({ view }: { view: EditorView | null }) {
  function insert(label: string) {
    if (!view) return;
    const text = TEXT[label] ?? label;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  return (
    <div
      role="toolbar"
      aria-label="Code symbols"
      className="flex gap-1 overflow-x-auto border-t border-[var(--border)] bg-[var(--tg-secondary-bg)] px-2 py-1.5"
      style={{ scrollbarWidth: "none" }}
    >
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          aria-label={k === "⇥" ? "Insert indent" : `Insert ${k}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => insert(k)}
          className="min-h-[34px] min-w-[34px] shrink-0 rounded-lg bg-[var(--tg-bg)] font-mono text-sm text-[var(--tg-text)] active:opacity-60"
        >
          {k}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Mount it in the file view**

In `bridge/miniapp/web/src/routes/files.tsx`, import it and hold the view:

```tsx
import KeyRow from "../components/KeyRow";
import type { EditorView } from "@codemirror/view";
```

Inside `FileView`, next to the other state:

```tsx
  const [view, setView] = useState<EditorView | null>(null);
```

Then replace the editor block at the end of `FileView`:

```tsx
      {editable && (
        <div className="flex h-[70vh] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)]">
          <div className="min-h-0 flex-1">
            <Suspense fallback={<Skeleton className="h-full w-full" />}>
              <CodeEditor path={path} initial={initial} onChange={setText} onView={setView} />
            </Suspense>
          </div>
          <KeyRow view={view} />
        </div>
      )}
```

- [ ] **Step 4: Add the save shortcut**

A phone can be paired with a keyboard, and the Mini App also runs in Telegram Desktop, where there is no Save button muscle memory without it. Add to `FileView`, after `save()`:

```tsx
  // Ctrl-S / Cmd-S — Telegram Desktop and any paired keyboard. Captured, so it
  // never reaches the browser's Save Page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
```

No dep array: `save` closes over `text`/`saving` and must be this render's.

- [ ] **Step 5: Verify**

```bash
cd bridge/miniapp/web && npx tsc --noEmit && npx vite build
```

Expected: clean. Then screenshot the built Mini App headless — see the `screenshot-miniapp-headless` memory for the chrome-headless-shell + `LD_LIBRARY_PATH` recipe — open a file and confirm the row renders below the buffer and scrolls horizontally. On a real phone: tap into the buffer, tap `{` — the keyboard stays up and `{` lands at the cursor.

- [ ] **Step 6: Commit**

```bash
git add bridge/miniapp/web/src/components/KeyRow.tsx \
        bridge/miniapp/web/src/components/CodeEditor.tsx \
        bridge/miniapp/web/src/routes/files.tsx
git commit -m "feat(miniapp): symbol row above the keyboard, and Ctrl-S to save"
```

---

### Task 5: Diff against HEAD, inline in the buffer

Reviewing agent-written code is the primary use of this editor, and today that means leaving it for the git view. `@codemirror/merge`'s `unifiedMergeView` puts the diff in the buffer itself: changed chunks highlighted, a gutter marker per changed line, and accept/reject buttons per chunk. The bridge already has every git helper needed except "this file's content at HEAD".

**Files:**
- Modify: `bridge/git.py` (add `show_head` after `show_file`, line ~666)
- Modify: `bridge/dashboard/server.py` (GET branch, next to `/local/files/read`)
- Modify: `tests/test_files_endpoints.py`
- Modify: `bridge/dashboard/web/src/api.ts`
- Modify: `bridge/dashboard/web/package.json`
- Modify: `bridge/dashboard/web/src/components/hud/EditorTab.tsx`

**Interfaces:**
- Consumes: the extension list and `CMDS` table from Tasks 1–3.
- Produces: `git.show_head(cwd, path) -> dict` returning `{"ok": bool, "content": str, "error": str}`; `GET /local/files/head?project=&path=&branch=` returning the same; `api.fileHead(project, path, branch?)`.

- [ ] **Step 1: Write the failing backend test**

Add to `tests/test_files_endpoints.py`, following the file's existing `_handler()` / `_get_api` style:

```python
def test_head_endpoint_returns_committed_content():
    """The diff base: a file's committed content, not the working tree's."""
    name, d = _mkproject("proj_head")
    with open(os.path.join(d, "a.txt"), "w") as f:
        f.write("hello\nworld\n")          # uncommitted edit on top of "hello\n"

    h, box = _handler()
    h._get_api("/local/files/head", {"project": [name], "path": ["a.txt"], "branch": [""]})
    assert box["obj"]["ok"] is True, box["obj"]
    assert box["obj"]["content"] == "hello\n", box["obj"]


def test_head_endpoint_rejects_a_file_not_in_head():
    """A file on disk but not in HEAD has no base to diff against — that must read
    as "no base", not as an empty file, or the whole buffer renders as an insertion."""
    name, d = _mkproject("proj_head_new")
    with open(os.path.join(d, "new.txt"), "w") as f:
        f.write("fresh\n")
    h, box = _handler()
    h._get_api("/local/files/head", {"project": [name], "path": ["new.txt"], "branch": [""]})
    assert box["obj"]["ok"] is False, box["obj"]
```

No registration needed — the file's `__main__` block discovers every `test_*` in `globals()`.

- [ ] **Step 2: Run it to confirm it fails**

```bash
python tests/test_files_endpoints.py
```

Expected: `FAIL test_head_endpoint_returns_committed_content: KeyError: 'obj'` — the path matches nothing, so `_json` is never called.

- [ ] **Step 3: Add the git helper**

In `bridge/git.py`, after `show_file` (line ~666):

```python
def show_head(cwd: str, path: str) -> dict:
    """A file's content at HEAD — the base the editor diffs the buffer against.
    Fails cleanly for a path that isn't in HEAD (new file, or no commits yet):
    an empty string would render the whole buffer as an insertion."""
    safe = _safe_path(cwd, path)
    if safe is None or not is_repo(cwd):
        return {"ok": False, "content": "", "error": "invalid path"}
    rc, out, err = _run(cwd, "show", f"HEAD:{safe}")
    if rc != 0:
        return {"ok": False, "content": "", "error": (err or "not in HEAD").strip()}
    return {"ok": True, "content": out, "error": ""}
```

- [ ] **Step 4: Add the endpoint**

In `bridge/dashboard/server.py`, in the GET branch immediately after the `/local/files/read` block (line ~412):

```python
        if path == "/local/files/head":
            # EDITOR diff view — the committed version of the open file
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(git.show_head(cwd, qs.get("path", [""])[0]))
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
python tests/test_files_endpoints.py
```

Expected: `PASS test_head_endpoint_returns_committed_content`, `PASS test_head_endpoint_rejects_a_file_not_in_head`, and `N/N passed`, exit 0.

- [ ] **Step 6: Install the dependency and add the client method**

```bash
cd bridge/dashboard/web && npm install @codemirror/merge
```

In `bridge/dashboard/web/src/api.ts`, next to `fileRead` (line ~946):

```ts
  fileHead: (project: string, path: string, branch?: string) =>
    req<{ ok: boolean; content: string; error?: string }>(
      `/local/files/head?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
```

- [ ] **Step 7: Wire the diff view**

In `EditorTab.tsx`:

```tsx
import { unifiedMergeView } from "@codemirror/merge";
```

Add a compartment beside `wrapComp`, and state beside `preview`:

```tsx
const diffComp = new Compartment();
```

```tsx
  // The HEAD text being diffed against, or null when the diff is off. Held (not
  // a bool) so toggling off and on again doesn't refetch.
  const [diffBase, setDiffBase] = useState<string | null>(null);
```

Add to the extension list inside `EditorState.create`, after `crtTheme`:

```tsx
        diffComp.of([]),   // filled in by toggleDiff — see below
```

Add the toggle:

```tsx
  /* Diff the buffer against the committed version, in place: changed chunks are
     highlighted with a gutter marker and per-chunk accept/reject buttons. The
     base is fetched once per toggle-on, so it reflects HEAD at that moment. */
  async function toggleDiff() {
    const v = viewRef.current;
    if (!v || !open) return;
    if (diffBase !== null) {
      setDiffBase(null);
      v.dispatch({ effects: diffComp.reconfigure([]) });
      return;
    }
    try {
      const r = await api.fileHead(project, open, branch || undefined);
      if (!r.ok) { flash(`E486: ${r.error || "not in HEAD"}`); return; }
      setDiffBase(r.content);
      v.dispatch({ effects: diffComp.reconfigure(
        unifiedMergeView({ original: r.content, gutter: true, mergeControls: true, highlightChanges: true }),
      ) });
    } catch (e) {
      flash(`E486: ${(e as Error).message}`);
    }
  }
```

Reset it when the open file changes — a base from another file would diff nonsense. Add to the top of the existing `open`-change effect (line ~309), right after the `if (!open)` guard:

```tsx
    setDiffBase(null);
```

That reset also fires on a tab switch *back*, whose cached state still carries the merge view from before — leaving the diff on screen while the palette offers to open it. Clear the compartment whenever a cached state is remounted. In the mount effect, right after `view.focus()`:

```tsx
    // A restored tab keeps whatever its compartments held; `diffBase` does not
    // survive the switch, so the diff has to go with it or the two disagree.
    if (cachedState) view.dispatch({ effects: diffComp.reconfigure([]) });
```

Append to `CMDS`:

```tsx
    { label: diffBase === null ? "Diff Against HEAD" : "Close Diff", key: "Ctrl+Shift+D",
      off: !editable, run: () => void toggleDiff() },
```

- [ ] **Step 8: Verify by hand**

Build and reload. Open a file with uncommitted changes, `Ctrl-Shift-D`: changed lines carry a gutter marker, deleted text shows above the new text, and each chunk has accept/reject buttons. Click reject on one chunk — that hunk reverts in the buffer and the tab goes dirty. `Ctrl-S` writes it. `Ctrl-Shift-D` again closes the diff. Open a brand-new untracked file and press `Ctrl-Shift-D` — the status bar reads `E486: …`, and the buffer is untouched.

- [ ] **Step 9: Commit**

```bash
git add bridge/git.py bridge/dashboard/server.py tests/test_files_endpoints.py \
        bridge/dashboard/web/package.json bridge/dashboard/web/package-lock.json \
        bridge/dashboard/web/src/api.ts \
        bridge/dashboard/web/src/components/hud/EditorTab.tsx
git commit -m "feat(editor): diff the open buffer against HEAD, with per-chunk accept/reject"
```

---

### Task 6: Language server support

The last real reason to leave: no completions, no type errors, no go-to-definition. The answer is a real language server on the bridge, not TypeScript in a web worker — Val Town shipped the worker approach first (`@typescript/vfs`) and abandoned it because large dependency trees drowned the worker; they moved to the official language server behind a websocket proxy. Our language server would run on the same disk as the repo's `node_modules`, so the worker's whole reason to exist is gone.

The transport is a straight mirror of the existing terminal websocket (`server.py:1309`), with two differences: text frames instead of binary, and LSP's `Content-Length` framing on the process side instead of a PTY.

**Files:**
- Create: `bridge/lsp.py`
- Create: `tests/test_lsp.py`
- Modify: `bridge/dashboard/server.py`
- Modify: `tests/test_files_endpoints.py`
- Create: `bridge/dashboard/web/src/lib/lsp.ts`
- Create: `bridge/dashboard/web/src/lib/lsp.check.ts`
- Modify: `bridge/dashboard/web/src/api.ts`
- Modify: `bridge/dashboard/web/package.json`
- Modify: `bridge/dashboard/web/src/lib/editorprefs.ts`
- Modify: `bridge/dashboard/web/src/lib/editorprefs.check.ts`
- Modify: `bridge/dashboard/web/src/components/hud/EditorTab.tsx`

**Interfaces:**
- Consumes: `EditorPrefs` (Tasks 2–3), the extension list and `CMDS` table.
- Produces: `bridge/lsp.py` — `SERVERS: dict[str, list[str]]`, `available(cwd) -> {"root": str, "langs": list[str]}`, `frame(obj) -> bytes`, `unframe(buf) -> tuple[list[dict], bytes]`, `attach(cwd, lang, send) -> Server | None` (the returned `Server` exposes `.write(obj) -> bool`), `detach(cwd, lang, send)`. `bridge/dashboard/web/src/lib/lsp.ts` — `lspLangId(path) -> string | null`, `fileUri(root, rel) -> string`, `lspExtension({project, branch, root, path, token}) -> Extension | null`. Which file goes to which server is decided **client-side** (`serverKey` in `lsp.ts`); the bridge only validates the `lang` it is handed against `SERVERS`.

- [ ] **Step 1: Write the failing framing test**

Create `tests/test_lsp.py`:

```python
"""The LSP stdio codec and the server registry. The framing is the load-bearing
part: a wrong Content-Length silently desynchronises the stream and every later
message is garbage, which looks like "completions randomly stop working".
Run: python tests/test_lsp.py"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import lsp  # noqa: E402


def test_frame_roundtrip():
    out = lsp.frame({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    head, _, body = out.partition(b"\r\n\r\n")
    assert head == b"Content-Length: %d" % len(body), head
    msgs, rest = lsp.unframe(out)
    assert len(msgs) == 1 and msgs[0]["method"] == "initialize", msgs
    assert rest == b"", rest


def test_unframe_batched():
    """Two messages in one read: both come out, nothing is left over."""
    a, b = lsp.frame({"id": 1}), lsp.frame({"id": 2})
    msgs, rest = lsp.unframe(a + b)
    assert [m["id"] for m in msgs] == [1, 2], msgs
    assert rest == b"", rest


def test_unframe_partial():
    """A message split across two reads: the first half yields nothing and is
    handed back intact, so the caller can prepend the next chunk."""
    a = lsp.frame({"id": 1})
    half = len(a) // 2
    msgs, rest = lsp.unframe(a[:half])
    assert msgs == [] and rest == a[:half], (msgs, rest)
    msgs, rest = lsp.unframe(rest + a[half:])
    assert [m["id"] for m in msgs] == [1], msgs


def test_unframe_utf8_length_is_bytes():
    """Content-Length counts bytes, not characters — a non-ASCII payload measured
    in characters truncates the message and desyncs everything after it."""
    obj = {"text": "héllo — ünicode"}
    assert len(json.dumps(obj).encode()) != len(json.dumps(obj)), "needs a multibyte payload"
    msgs, rest = lsp.unframe(lsp.frame(obj))
    assert msgs[0]["text"] == obj["text"], msgs
    assert rest == b"", rest


def test_available_reports_only_installed_servers():
    """The editor asks before offering LSP — an uninstalled server must read as
    "not available", never as a broken socket the user has to diagnose."""
    got = lsp.available("/tmp")
    assert got["root"] == "/tmp", got
    assert set(got["langs"]) <= set(lsp.SERVERS), got


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
python tests/test_lsp.py
```

Expected: `ModuleNotFoundError: No module named 'bridge.lsp'`.

- [ ] **Step 3: Write the module**

Create `bridge/lsp.py`:

```python
"""Language servers for the dashboard editor.

One server process per (project, language), shared by every tab and every open
browser, reference-counted and reaped when the last subscriber leaves. The
process speaks LSP over stdio; the websocket in dashboard/server.py speaks bare
JSON. This module owns the translation and the process lifetime — the proxy
above it is deliberately dumb, so the `initialize` handshake, capabilities and
document sync all stay client-side where codemirror-languageserver already
implements them.

Mirrors bridge/terminals.py's attach/detach/send shape; read that first.
"""

import json
import shutil
import subprocess
import threading

# Language id -> the command that starts its server. Both are optional installs;
# `available()` reports which are actually on PATH so the editor can degrade.
SERVERS: "dict[str, list[str]]" = {
    "ts": ["typescript-language-server", "--stdio"],
    "py": ["pyright-langserver", "--stdio"],
}

_procs: "dict[tuple[str, str], Server]" = {}
_lock = threading.Lock()


def available(cwd: str) -> dict:
    """Which servers this machine can actually start. `root` is the absolute
    project directory — the client needs it to build the file:// URIs LSP wants."""
    return {"root": cwd,
            "langs": sorted(k for k, cmd in SERVERS.items() if shutil.which(cmd[0]))}


def frame(obj: dict) -> bytes:
    """One JSON-RPC message in LSP's stdio framing. Content-Length is a byte
    count — measuring the string in characters truncates any non-ASCII payload."""
    body = json.dumps(obj).encode()
    return b"Content-Length: %d\r\n\r\n%s" % (len(body), body)


def unframe(buf: bytes) -> "tuple[list[dict], bytes]":
    """Pull every complete message out of `buf`; return them plus the unconsumed
    tail. A short read leaves the whole buffer intact for the next chunk."""
    out = []
    while True:
        head, sep, rest = buf.partition(b"\r\n\r\n")
        if not sep:
            return out, buf
        length = 0
        for line in head.split(b"\r\n"):
            name, _, value = line.partition(b":")
            if name.strip().lower() == b"content-length":
                try:
                    length = int(value.strip())
                except ValueError:
                    return out, b""      # unparseable header: the stream is lost
        if len(rest) < length:
            return out, buf              # incomplete body — wait for more
        try:
            out.append(json.loads(rest[:length]))
        except ValueError:
            pass                         # skip a malformed message, keep the stream
        buf = rest[length:]


class Server:
    def __init__(self, cwd: str, lang: str):
        self.cwd = cwd
        self.lang = lang
        self.alive = True
        self._subs: set = set()
        self._subs_lock = threading.Lock()
        self.proc = subprocess.Popen(
            SERVERS[lang], cwd=cwd,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,      # servers are chatty; nothing reads it
        )
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self) -> None:
        buf = b""
        while True:
            chunk = self.proc.stdout.read(4096) if self.proc.stdout else b""
            if not chunk:
                break
            buf += chunk
            msgs, buf = unframe(buf)
            if not msgs:
                continue
            with self._subs_lock:
                subs = list(self._subs)
            for send in subs:
                for m in msgs:
                    send(m)
        self.alive = False

    def write(self, obj: dict) -> bool:
        if not self.alive or not self.proc.stdin:
            return False
        try:
            self.proc.stdin.write(frame(obj))
            self.proc.stdin.flush()
            return True
        except (OSError, ValueError):
            self.alive = False
            return False

    def kill(self) -> None:
        self.alive = False
        try:
            self.proc.kill()
        except OSError:
            pass


def attach(cwd: str, lang: str, send) -> "Server | None":
    """Subscribe to (starting if needed) the server for this project+language.
    `send` is called with each decoded message. None if the server isn't installed."""
    if lang not in SERVERS or not shutil.which(SERVERS[lang][0]):
        return None
    with _lock:
        srv = _procs.get((cwd, lang))
        if srv is None or not srv.alive:
            srv = Server(cwd, lang)
            _procs[(cwd, lang)] = srv
    with srv._subs_lock:
        srv._subs.add(send)
    return srv


def detach(cwd: str, lang: str, send) -> None:
    """Drop a subscriber, and the process with the last one — a language server
    idling on a project nobody has open costs hundreds of MB of RSS."""
    with _lock:
        srv = _procs.get((cwd, lang))
        if srv is None:
            return
        with srv._subs_lock:
            srv._subs.discard(send)
            empty = not srv._subs
        if empty:
            _procs.pop((cwd, lang), None)
            srv.kill()
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
python tests/test_lsp.py
```

Expected: five `PASS test_…` lines then `5/5 passed`, exit 0.

- [ ] **Step 5: Add the availability endpoint and its test**

Add to `tests/test_files_endpoints.py` (auto-discovered, no registration needed):

```python
def test_lsp_available_endpoint():
    """The endpoint resolves the project to an absolute root — the client builds
    every file:// URI from it, so a relative or unresolved path breaks every request."""
    name, d = _mkproject("proj_lsp")
    h, box = _handler()
    h._get_api("/local/lsp/available", {"project": [name], "branch": [""]})
    assert box["obj"]["root"] == os.path.realpath(d), box["obj"]
    assert set(box["obj"]["langs"]) <= {"ts", "py"}, box["obj"]


def test_lsp_available_invalid_project():
    h, box = _handler()
    h._get_api("/local/lsp/available", {"project": ["does_not_exist_xyz"], "branch": [""]})
    assert box["code"] == 400
```

Then in `bridge/dashboard/server.py`, import `lsp` alongside the other bridge modules and add to the GET branch after `/local/files/head`:

```python
        if path == "/local/lsp/available":
            # EDITOR: which language servers this machine can actually start
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(lsp.available(cwd))
```

Run `python tests/test_files_endpoints.py` — expected: `PASS test_lsp_available_endpoint`, `PASS test_lsp_available_invalid_project`, and `N/N passed`.

- [ ] **Step 6: Add the websocket proxy**

In `bridge/dashboard/server.py`, add `_lsp_ws` directly below `_terminal_ws`, and route it where `_terminal_ws` is routed (find the existing `"/local/terminal/ws"` dispatch and add the sibling `if path == "/local/lsp": return self._lsp_ws(qs)`):

```python
    # --- language-server websocket (Host + Origin + ?token= gated, like the terminal) ---
    def _lsp_ws(self, qs):
        """Upgrade to a websocket bound to one project's language server and pump
        JSON-RPC both ways. Client frames are text carrying one bare JSON message;
        this end adds and strips LSP's Content-Length framing. The handshake,
        capabilities and document sync are all the client's — see bridge/lsp.py."""
        if self.headers.get("Upgrade", "").lower() != "websocket":
            return self._json({"error": "expected websocket"}, 400)
        if not _ws_authorized(self.headers.get("Host", ""),
                              self.headers.get("Origin", ""),
                              qs.get("token", [""])[0]):
            return self._json({"error": "unauthorized"}, 401)
        cwd = _worktree_cwd(qs.get("project", [None])[0],
                            (qs.get("branch", [""])[0] or "").strip())
        if cwd is None:
            return self._json({"error": "invalid project"}, 400)
        lang = qs.get("lang", [""])[0]
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._json({"error": "missing key"}, 400)

        send_lock = threading.Lock()

        def _send(msg: dict) -> bool:
            with send_lock:
                try:
                    self.wfile.write(wsutil.encode_frame(
                        json.dumps(msg).encode(), wsutil.OP_TEXT))
                    self.wfile.flush()
                    return True
                except OSError:
                    return False

        # Attach before the 101 — an uninstalled server should be a clean HTTP
        # error the editor can report, not a socket that opens and dies.
        srv = lsp.attach(cwd, lang, _send)
        if srv is None:
            return self._json({"error": f"no language server for {lang!r}"}, 404)

        self.close_connection = True
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", wsutil.accept_key(key))
        self.end_headers()
        try:
            self.wfile.flush()
        except OSError:
            lsp.detach(cwd, lang, _send)
            return

        try:
            while True:
                got = wsutil.decode_frame(self.rfile)
                if got is None:
                    break
                opcode, payload = got
                if opcode == wsutil.OP_CLOSE:
                    break
                if opcode not in (wsutil.OP_TEXT, wsutil.OP_BINARY):
                    continue
                try:
                    srv.write(json.loads(payload))
                except ValueError:
                    continue        # a malformed client message isn't fatal
        finally:
            lsp.detach(cwd, lang, _send)
```

- [ ] **Step 7: Write the failing client-side check**

Create `bridge/dashboard/web/src/lib/lsp.check.ts`:

```ts
// Run: node --experimental-strip-types src/lib/lsp.check.ts  (from web/)
//
// The language id and the file URI are what the server keys every request on.
// A wrong id gets silently ignored; a wrong URI gets diagnostics for a file that
// doesn't exist, which looks like "the LSP is broken".
import { fileUri, lspLangId } from "./lsp.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(got === want, `${what} — got ${JSON.stringify(got)}`);

eq(lspLangId("src/a.ts"), "typescript", "ts");
eq(lspLangId("src/a.tsx"), "typescriptreact", "tsx is its own id");
eq(lspLangId("src/a.js"), "javascript", "js");
eq(lspLangId("src/a.jsx"), "javascriptreact", "jsx is its own id");
eq(lspLangId("bridge/git.py"), "python", "py");
eq(lspLangId("README.md"), null, "no server for markdown");
eq(lspLangId("Makefile"), null, "no extension, no server");

eq(fileUri("/home/u/proj", "src/a.ts"), "file:///home/u/proj/src/a.ts", "uri joins root and path");
eq(fileUri("/home/u/proj/", "src/a.ts"), "file:///home/u/proj/src/a.ts", "a trailing slash is not doubled");
eq(fileUri("/home/u/my proj", "a.ts"), "file:///home/u/my%20proj/a.ts", "spaces are encoded");
```

Run it: `cd bridge/dashboard/web && node --experimental-strip-types src/lib/lsp.check.ts`. Expected: `Cannot find module './lsp.ts'`.

- [ ] **Step 8: Install the deps and write the client module**

```bash
cd bridge/dashboard/web && npm install @marimo-team/codemirror-languageserver @open-rpc/client-js
```

Create `bridge/dashboard/web/src/lib/lsp.ts`:

```ts
import { languageServer } from "@marimo-team/codemirror-languageserver";
import { WebSocketTransport } from "@open-rpc/client-js";
import type { Extension } from "@codemirror/state";

/* Completions, hover types, diagnostics, go-to-definition and rename, from a real
   language server running on the bridge — where the repo's node_modules and its
   tsconfig already are. The alternative, TypeScript in a web worker, is the thing
   Val Town shipped and then abandoned: a large dependency tree drowns the worker.

   The bridge proxies bare JSON over a websocket (bridge/lsp.py); this side does
   the LSP handshake itself, via the library. */

// LSP's own language ids, which are not the file extensions.
const LANG_IDS: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact",
  js: "javascript", jsx: "javascriptreact",
  mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
};

/** The LSP language id for a path, or null when no server handles it. */
export function lspLangId(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (!name.includes(".")) return null;
  return LANG_IDS[name.split(".").pop()!.toLowerCase()] ?? null;
}

/** file:// URI for a repo-relative path under an absolute root. */
export function fileUri(root: string, rel: string): string {
  const base = root.replace(/\/+$/, "");
  return `file://${`${base}/${rel}`.split("/").map(encodeURIComponent).join("/")}`;
}

/** Which bridge server handles this path — matches SERVERS in bridge/lsp.py. */
function serverKey(path: string): string | null {
  const id = lspLangId(path);
  if (id === null) return null;
  return id === "python" ? "py" : "ts";
}

/** The extension for one open file, or null when nothing serves it. `token` is
 *  the dashboard token — the websocket gate needs it in the query string, since
 *  a websocket can't carry the X-Dash-Token header. */
export function lspExtension(opts: {
  project: string; branch: string; root: string; path: string; token: string;
}): Extension | null {
  const key = serverKey(opts.path);
  const langId = lspLangId(opts.path);
  if (key === null || langId === null) return null;
  const q = new URLSearchParams({ project: opts.project, lang: key, token: opts.token });
  if (opts.branch) q.set("branch", opts.branch);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return languageServer({
    transport: new WebSocketTransport(`${proto}//${location.host}/local/lsp?${q}`),
    rootUri: fileUri(opts.root, ""),
    documentUri: fileUri(opts.root, opts.path),
    languageId: langId,
    // The completion list from tsserver is long; filtering in the browser as you
    // type beats a round trip per keystroke.
    clientSideFiltering: true,
    allowHTMLContent: false,   // hover docs are server text — don't run it as HTML
  });
}
```

- [ ] **Step 9: Run the check to confirm it passes**

```bash
cd bridge/dashboard/web && node --experimental-strip-types src/lib/lsp.check.ts
```

Expected: ten `ok - …` lines, exit 0.

- [ ] **Step 10: Add the pref and its check**

In `editorprefs.check.ts`, add:

```ts
eq(mergePrefs(null).lsp, true, "lsp is on by default");
eq(mergePrefs('{"lsp":false}').lsp, false, "a stored lsp flag wins");
```

In `editorprefs.ts`, add `lsp: boolean;` to `EditorPrefs`, `lsp: true,` to `DEFAULT_PREFS`, and to `mergePrefs`:

```ts
    lsp: typeof stored.lsp === "boolean" ? stored.lsp : DEFAULT_PREFS.lsp,
```

Run the check — expected: all `ok - …`, exit 0. On by default because it costs nothing when no server is installed: `available` returns an empty `langs` and the editor never opens a socket.

- [ ] **Step 11: Wire it into the editor**

In `api.ts`, next to `fileHead`:

```ts
  lspAvailable: (project: string, branch?: string) =>
    req<{ root: string; langs: string[] }>(
      `/local/lsp/available?project=${encodeURIComponent(project)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
```

In `EditorTab.tsx`:

```tsx
import { lspExtension, lspLangId } from "../../lib/lsp";
```

Add a compartment beside `diffComp`, and state beside `prefs`:

```tsx
const lspComp = new Compartment();
```

```tsx
  // {root, langs} for this project, or null while unknown / when nothing is installed.
  const [lspInfo, setLspInfo] = useState<{ root: string; langs: string[] } | null>(null);
```

Fetch it when the project or branch changes:

```tsx
  useEffect(() => {
    let live = true;
    setLspInfo(null);
    void api.lspAvailable(project, branch || undefined)
      .then((r) => { if (live && r.langs.length) setLspInfo(r); })
      .catch(() => { /* no LSP is a normal state, not an error to report */ });
    return () => { live = false; };
  }, [project, branch]);
```

Add to the extension list inside `EditorState.create`, after `diffComp.of([])`:

```tsx
        lspComp.of([]),   // filled in below, once we know what's installed
```

And build it after the view mounts — put this immediately after the existing `void desc?.load()…` block in the same effect:

```tsx
    // Completions/diagnostics/go-to-def, when a server for this file exists.
    // Built after the view so a slow websocket never delays the buffer appearing.
    // Only for a fresh state: a restored tab already carries its extension, and
    // reconfiguring would open a second websocket on every switch.
    const ext = !cachedState && prefs.lsp && lspInfo && lspLangId(open)
      ? lspExtension({ project, branch, root: lspInfo.root, path: open, token: TOKEN })
      : null;
    if (ext) view.dispatch({ effects: lspComp.reconfigure(ext) });
```

`TOKEN` is already exported from `api.ts:6` (the terminal websocket at `api.ts:891` passes it the same way) — widen the existing import in `EditorTab.tsx:11` to `import { api, TOKEN, type FileContent, type GrepHit } from "../../api";` rather than reading the query string twice.

Add `lspInfo` and `prefs.lsp` to that effect's dependency array — but a remount alone isn't enough, because the `!cachedState` guard skips a restored tab. Drop the cached states when either changes, so the next mount is fresh:

```tsx
  /* `lspAvailable` resolves after the first file is already open, and toggling
     the pref has to take effect on tabs that are open now — both need a fresh
     state, since the extension lives inside one. Costs the undo history of any
     open tab, which in practice is the single file the editor opened with. */
  useEffect(() => {
    for (const b of bufs.current.values()) delete b.state;
  }, [lspInfo, prefs.lsp]);
```

Place it **above** the mount effect: React runs effects in declaration order, so the clear must land before the mount reads `cachedState`.

Append to `CMDS`:

```tsx
    { label: `Language Server — ${prefs.lsp ? "on" : "off"}`, off: !lspInfo,
      run: () => setPrefs((p) => ({ ...p, lsp: !p.lsp })) },
```

And surface it in the status bar so a missing server is visible rather than mysterious — extend the `statusRight` expression's `editable` branch:

```tsx
      : editable ? `${lang || "…"} · ${indentLabel} · utf-8 · ${lineCount}L${
          prefs.lsp && lspInfo && lspLangId(open ?? "") ? " · lsp" : ""}` : "");
```

- [ ] **Step 12: Verify end to end**

Install at least one server if the machine has none:

```bash
npm install -g typescript-language-server typescript   # or: pip install pyright
```

Confirm the backend agrees, without restarting the bridge:

```bash
python tests/test_lsp.py && python tests/test_files_endpoints.py
```

Then build the dashboard and reload. **The websocket endpoint only exists in a bridge started after this commit** — so this last check has to wait for the next natural bridge restart; say so plainly rather than reporting it as verified. When it is live: open a `.ts` file, type `document.` — a completion list appears; hover an identifier — its type shows; introduce a type error — a red squiggle and a message appear; Ctrl-click a symbol — the definition opens in a tab. The status bar right side ends with `· lsp`. On a `.md` file it does not.

- [ ] **Step 13: Commit**

```bash
git add bridge/lsp.py tests/test_lsp.py bridge/dashboard/server.py \
        tests/test_files_endpoints.py \
        bridge/dashboard/web/src/lib/lsp.ts bridge/dashboard/web/src/lib/lsp.check.ts \
        bridge/dashboard/web/src/lib/editorprefs.ts \
        bridge/dashboard/web/src/lib/editorprefs.check.ts \
        bridge/dashboard/web/src/api.ts \
        bridge/dashboard/web/package.json bridge/dashboard/web/package-lock.json \
        bridge/dashboard/web/src/components/hud/EditorTab.tsx
git commit -m "feat(editor): language server support over the bridge — completions, diagnostics, go-to-def"
```

---

## Final verification

After the last task, everything runs green:

```bash
python tests/test_lsp.py
python tests/test_files_endpoints.py
python tests/test_git.py
cd bridge/dashboard/web && node --experimental-strip-types src/lib/editorprefs.check.ts \
  && node --experimental-strip-types src/lib/lsp.check.ts \
  && node --experimental-strip-types src/lib/tabs.check.ts \
  && npx tsc --noEmit && npx vite build
cd bridge/miniapp/web && npx tsc --noEmit && npx vite build
```

The backend suite baseline is 809 passed / 4 failed — the 4 are the pre-existing MCP-allowlist defaults from 12a025d. Anything else failing is new breakage from this plan.

## Deliberately not in this plan

Named so nobody adds them by reflex: minimap, split editors, sticky scroll, breadcrumbs, a user-editable `keybindings.json`, in-browser WASM formatters (Biome/dprint — the bridge already runs the project's own formatters, which is strictly better), notebook support, and code-server. Add any of them when someone actually asks for it.
