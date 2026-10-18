# Context Menus, Slice 1 (the broken items) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The composer and the EDITOR body get real edit menus, WORKTREES and TASKS rows get the menus their types promise, a right-click no longer zooms or closes the lightbox, and the Browser tail only lists rows that work inside Mystical.app.

**Architecture:** One new module, `lib/editorctx.ts`, is a registry of CodeMirror views plus DOM-free clipboard helpers; App's `ctxItems` grows an `editor` branch that reads it. WORKTREES and TASKS rows get component-built menus in the FilesPanel pattern (own `<ContextMenu>`, `preventDefault` + `stopPropagation`), because their actions are local state. Two one-line guards (lightbox pointer button, native tail) and a label fallback round it out. No backend change; ships by dist copy.

**Tech Stack:** React 19 + TypeScript (dashboard), CodeMirror 6 (`@codemirror/view`, `@codemirror/commands`), `*.check.ts` scripts run with `node --experimental-strip-types`, Chrome headless probes via `.mystical/probe/probe.py` + `.mystical/probe-mac/cdp.mjs`.

**Spec:** `docs/superpowers/specs/context-menus.md` (slice 1 = "Broken first"; the inventory it cites is `.mystical/docs/context-menu-inventory.md`).

## Global Constraints

- Mechanism stays: the window `contextmenu` listener in `App.tsx`, `data-ctx-type` / `data-ctx-id` / `data-ctx-label`, rows built in `ctxItems`, `lib/nativeCtx.ts` rows leading, "Dashboard ›" and "Browser ›" tail. Local menus keep the FilesPanel pattern.
- `components/hud/ContextMenu.tsx` chrome unchanged: 216px, one submenu level.
- No menu over eight top rows.
- Inputs and textareas keep the browser menu; Shift+right-click keeps reaching it everywhere (listener lines unchanged).
- Non-React logic lives in `lib/*.ts` with a `*.check.ts` script.
- Paste uses `navigator.clipboard.read()`; a refusal shows a toast that says ⌘V; the row stays.
- Work happens in a worktree at `~/Projects/.worktrees/mystical-assistant/feat-context-menus` (bridge-worktree skill); never commit the `node_modules` symlink.
- Commit messages: no Claude co-author line (user's CLAUDE.md).
- Before merge: `npm run build` clean (runs `tsc -b`), every touched `*.check.ts` passes, `python3 -m pytest tests/ -q` green, one headless capture per new menu attached.

## Review Focus

1. Text selected in the composer, right-click → one Copy row, not two (the native selection rows and the editor's own Copy would both appear). Pinned in Task 4 step 1 (the `editor` branch starts from an empty list).
2. WebKit refuses `clipboard.read()` → the Paste row toasts "press ⌘V" instead of failing silently. Pinned in Task 1 (`pasteInto` returns `"refused"`) and Task 4 (toast).
3. Right-click a worktree row while a different row is expanded → the menu acts on the row under the cursor. Pinned in Task 5 (menu state carries the clicked `name`; rows read only from it).
4. Right-click a lightbox picture → the menu opens and the picture does not zoom; on the backdrop, the lightbox stays open. Pinned in Task 7.
5. A type with no label (any future `data-ctx-type`) → the header shows the type upper-cased, never "DASHBOARD". Pinned in Task 4 step 4.

---

### Task 1: `lib/editorctx.ts` — the view registry and clipboard helpers

**Files:**
- Create: `bridge/dashboard/web/src/lib/editorctx.ts`
- Create: `bridge/dashboard/web/src/lib/editorctx.check.ts`

**Interfaces:**
- Consumes: nothing from the app. Structural `ViewLike` only, so the module imports no CodeMirror package and the check runs under plain Node.
- Produces:
  ```ts
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
  export function registerEditor(id: string, entry: EditorEntry): () => void;   // returns the unregister
  export function editorFor(id: string): EditorEntry | undefined;
  export function selectedText(view: ViewLike): string;
  export function copySelection(view: ViewLike): Promise<boolean>;             // false when nothing is selected
  export function cutSelection(view: ViewLike): Promise<boolean>;              // copy, then delete the range; false when nothing selected
  export type PasteOutcome = "text" | "files" | "empty" | "refused";
  export function pasteInto(view: ViewLike, files?: (f: File[]) => void): Promise<PasteOutcome>;
  ```
  `pasteInto`: `navigator.clipboard.read()`; image items (`type.startsWith("image/")`) become `File`s handed to `files` when it is given, else skipped; the first `text/plain` item is inserted over the selection with the caret placed after it, then `focus()`. Returns `"files"` when only images went out, `"text"` when text went in (text wins when both happened), `"empty"` when nothing usable was on the clipboard, `"refused"` when `read` is missing or throws. If `read` is missing but `readText` exists, use `readText` (text only).

- [ ] **Step 1: Write the failing check**

`editorctx.check.ts`, in the style of `lib/mac.check.ts` (stub `navigator` with `Object.defineProperty`, dynamic `import("./editorctx.ts")`, `console.assert`, final `console.log("editorctx.check: done")`). A `fakeView(doc, from, to)` helper records every `dispatch` in an array and implements `sliceString`. Assertions:
```ts
// registry
const off = registerEditor("composer", { view: v });
console.assert(editorFor("composer")?.view === v, "registered view is returned");
off();
console.assert(editorFor("composer") === undefined, "unregister removes it");
// selection
console.assert(selectedText(fakeView("hello world", 6, 11)) === "world");
console.assert(selectedText(fakeView("hello", 2, 2)) === "", "a caret selects nothing");
// copy / cut
const written: string[] = []; // navigator.clipboard.writeText pushes here
console.assert(await copySelection(fakeView("hello world", 0, 5)) === true && written[0] === "hello");
console.assert(await copySelection(fakeView("hello", 1, 1)) === false, "nothing selected, nothing written");
const cutV = fakeView("hello world", 0, 6);
console.assert(await cutSelection(cutV) === true && written[1] === "hello " && cutV.dispatched[0].changes.from === 0 && cutV.dispatched[0].changes.to === 6 && cutV.dispatched[0].changes.insert === "");
// paste: text
// navigator.clipboard.read resolves [{ types: ["text/plain"], getType: async () => new Blob(["pasted"]) }]
const pv = fakeView("ab", 1, 1);
console.assert(await pasteInto(pv) === "text" && pv.dispatched[0].changes.insert === "pasted" && pv.dispatched[0].selection.anchor === 7);
// paste: image with a files sink
// read resolves [{ types: ["image/png"], getType: async () => new Blob([new Uint8Array(4)], { type: "image/png" }) }]
const got: File[] = [];
console.assert(await pasteInto(fakeView("", 0, 0), (f) => got.push(...f)) === "files" && got.length === 1 && got[0].type === "image/png");
// paste: image with no sink → empty
console.assert(await pasteInto(fakeView("", 0, 0)) === "empty");
// paste: refused
// read rejects with new Error("NotAllowedError")
console.assert(await pasteInto(fakeView("", 0, 0)) === "refused");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bridge/dashboard/web && node --experimental-strip-types src/lib/editorctx.check.ts`
Expected: fails to import `./editorctx.ts` (module not found).

- [ ] **Step 3: Implement `lib/editorctx.ts`**

A module-level `Map<string, EditorEntry>`. `registerEditor` overwrites a stale entry with the same id (the composer is rebuilt on layout change) and the returned function deletes the id only if the map still holds that same entry. Module docstring: why structural types (DOM-free check), why a registry (App builds menu rows for views owned by components).

- [ ] **Step 4: Run the check to verify it passes**

Run: `node --experimental-strip-types src/lib/editorctx.check.ts`
Expected: `editorctx.check: done` and no assertion output.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/lib/editorctx.ts bridge/dashboard/web/src/lib/editorctx.check.ts
git commit -m "dashboard: lib/editorctx — registry of CodeMirror views + DOM-free clipboard helpers for the right-click edit rows"
```

---

### Task 2: The composer registers itself as `composer`

**Files:**
- Modify: `bridge/dashboard/web/src/components/MarkdownInput.tsx` (the `useEffect` that builds the view at ~96, the returned host `<div>` at ~160, `Props`)
- Modify: `bridge/dashboard/web/src/components/Composer.tsx` (`<MarkdownInput>` mount at ~1162-1181, the `openDrop` click-catcher at ~1245)

**Interfaces:**
- Consumes: `registerEditor` (Task 1).
- Produces: a registry entry `composer` with `actions: { attach, mention, clear }`; the host carries `data-ctx-type="editor" data-ctx-id="composer" data-ctx-label="prompt"`.
- `MarkdownInput` `Props` gain `onAttach?: () => void` and `onClear?: () => void`.

- [ ] **Step 1: Register in `MarkdownInput`**

Inside the view-building effect, right after `viewRef.current = view` (or wherever the view is assigned), call:
```ts
const off = registerEditor("composer", {
  view,
  actions: {
    attach: () => cb.current.onAttach?.(),
    clear: () => cb.current.onClear?.(),
    // typing "@" is what opens the mention list, so insert one at the caret and let onChange do the rest
    mention: () => { view.dispatch(view.state.replaceSelection("@")); view.focus(); },
  },
});
```
and call `off()` in the effect's cleanup before `view.destroy()`. Put the three `data-ctx-*` attributes on the returned host `<div>`.

- [ ] **Step 2: Wire the composer**

At the `<MarkdownInput>` mount pass `onAttach={() => fileRef.current?.click()}` and `onClear={() => { if (text.includes("\n")) void askConfirm("Clear the draft?").then((yes) => yes && setText("")); else setText(""); }}` (`askConfirm` from `./ui/Ask`). Widen the `fileSink` prop type from `(files: FileList) => void` to `(files: FileList | File[]) => void` (what `addFiles` already accepts) and the matching `composerFiles` ref in `App.tsx`, so Task 4 can hand it pasted `File[]`. On the `openDrop` click-catcher add `onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOpenDrop(""); }}` so a right-click while a picker is open closes it instead of opening the DASHBOARD menu.

- [ ] **Step 3: Type-check**

Run: `cd bridge/dashboard/web && npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/components/MarkdownInput.tsx bridge/dashboard/web/src/components/Composer.tsx
git commit -m "dashboard: the composer registers its CodeMirror view as 'composer' (attach / mention / clear actions) and tags its host for the editor menu"
```

---

### Task 3: The EDITOR tab registers itself as `editor`

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/EditorTab.tsx` (view creation ~474-475, teardown ~506, host `<div ref={hostRef}>` ~1162, `CMDS` ~751)

**Interfaces:**
- Consumes: `registerEditor` (Task 1).
- Produces: registry entry `editor` with `path: () => open` (the open file's repo-relative path, as `CMDS` uses it) and `actions: { format, symbol, find }` where `format` runs the same thing as the "Format Document" command and is omitted when that command is `off`, `symbol` = `setPalQ("@")`, `find` = `showView("search")`. The host carries `data-ctx-type="editor" data-ctx-id="editor"` and `data-ctx-label={open}`.

- [ ] **Step 1: Register and unregister with the view's lifetime**

Right after `viewRef.current = view;` register; in the cleanup that calls `view.destroy()` unregister first. Because `open`, `editable` and `meta` change after the view is built, the entry's `path` and `actions` read them through a ref the component updates every render (the same `cb`-ref pattern `MarkdownInput` uses), so the registry never holds stale closures. If `history()` from `@codemirror/commands` is not among the editor's extensions (check the `extensions` array; `basicSetup` includes it, a hand-rolled list may not), add `history()` and `historyKeymap` so Undo/Redo rows have something to act on.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/EditorTab.tsx
git commit -m "dashboard: the EDITOR body registers its CodeMirror view as 'editor' (format / symbol / find actions, open path) and tags its host for the editor menu"
```

---

### Task 4: App builds the `editor` rows; labels fall back to the type name

**Files:**
- Modify: `bridge/dashboard/web/src/App.tsx` (`ctxItems` useMemo, the branch chain after `weather`; imports)
- Modify: `bridge/dashboard/web/src/components/hud/ContextMenu.tsx` (`TYPE_LABEL`, header at ~126)

**Interfaces:**
- Consumes: `editorFor`, `selectedText`, `copySelection`, `cutSelection`, `pasteInto` (Task 1); `undo`, `redo`, `selectAll` from `@codemirror/commands`; the existing `quote(text)`, `notify(kind, text)`, `composerFiles` ref (the composer's `fileSink`).
- Produces: the `editor` menu.

- [ ] **Step 1: The `editor` branch in `ctxItems`**

The line that seeds `items` with `nativeCtx.top` becomes `const items: CtxItem[] = nativeCtx.top.length && ctxMenu.type !== "editor" ? [...nativeCtx.top, { divider: true }] : [];` (Review Focus 1: an editor menu has its own Copy), then the new branch:
```
const ed = editorFor(ctxMenu.id); if (!ed) → fall through to the generic rows
const v = ed.view as unknown as EditorView; const sel = selectedText(ed.view);
✂ Cut            hint ⌘X   → void cutSelection(ed.view)
⧉ Copy           hint ⌘C   → void copySelection(ed.view)
⎘ Paste          hint ⌘V   → void pasteInto(ed.view, ctxMenu.id === "composer" ? (f) => composerFiles.current?.(f) : undefined)
                              .then((r) => { if (r === "refused") notify("info", "Paste is blocked from the menu here — press ⌘V in the box."); else if (r === "empty") notify("info", "Nothing to paste."); })
☰ Select all     hint ⌘A   → selectAll(v)
↶ Undo           hint ⌘Z   → undo(v)
↷ Redo           hint ⇧⌘Z  → redo(v)
divider
composer: ⊕ Attach file… → actions.attach · @ Insert file mention → actions.mention · ⌫ Clear draft (danger) → actions.clear
editor:   ⌥ Format document (only when actions.format exists) · ◎ Go to symbol… → actions.symbol · ⌕ Find in files → actions.find
          divider · ❞ Send selection to chat (only when sel) hint "quotes path:line into the prompt"
          → quote(`${ed.path?.() ?? "selection"}:${lineOf(v, from)}\n${sel}`)   // lineOf = v.state.doc.lineAt(from).number
divider
```
then the existing generic tail (Dashboard ›, Browser ›) as for every non-surface type. Keep `ctxMenu.label` as the header label ("prompt" / the open path).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 3: Probe the composer menu**

Build the worktree (`npm run build`), serve it read-only against the live bridge, right-click the composer and capture:
```bash
python3 .mystical/probe/probe.py 8893 ~/Projects/.worktrees/mystical-assistant/feat-context-menus/bridge/dashboard/web/dist 8790 &
node .mystical/probe-mac/cdp.mjs "http://127.0.0.1:8893/?skipboot" .mystical/mock/s1-composer.png 1280 860 3500 \
  "(() => { const el = document.querySelector('[data-ctx-id=\"composer\"] .cm-content'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 })); return 'ok'; })()" 600 2
```
Expected: the capture shows a menu headed `EDITOR prompt` with Cut … Redo, Attach file…, Insert file mention, Clear draft, Dashboard ›, Browser ›. Attach a crop with `mcp__verify__Attach`. Repeat with the EDITOR tab open (open the Analyze modal's EDITOR tab from the ⊞ PROJECT button in the eval, open any file, then dispatch on `[data-ctx-id="editor"] .cm-content`); expected header `EDITOR <path>` with Format document, Go to symbol…, Find in files. Where the live bridge's state makes a step impossible headlessly (no project open), say so in the hand-back rather than skipping silently.

- [ ] **Step 4: Label fallback**

In `ContextMenu.tsx` add `editor: "EDITOR", task: "TASK"` to `TYPE_LABEL` and change the header to `TYPE_LABEL[ctx.type] || ctx.type.toUpperCase()` (`surface` already maps to DASHBOARD).

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/App.tsx bridge/dashboard/web/src/components/hud/ContextMenu.tsx
git commit -m "dashboard: right-click in the prompt box or the EDITOR body is an edit menu — Cut/Copy/Paste/Select all/Undo/Redo plus the box's own rows — instead of the dashboard menu; unknown menu types show their own name"
```

---

### Task 5: WORKTREES rows get a branch menu

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/WorktreesTab.tsx` (`branchRow` ~186-270, state ~48-71, imports)

**Interfaces:**
- Consumes: the component's own `checkout(name)`, `doMerge(name, target)`, `setConfirmDel`, `onWorktreeSession`, `onSelectSession`, and the per-name derivations already computed in `branchRow` (`wt`, `open`, `isMerged`, `sess`, `current`, `targets`).
- Produces: a component-built `<ContextMenu>` with `type: "branch"`.

- [ ] **Step 1: Replace the dead registration with a local menu**

Remove `data-ctx-type="branch" data-ctx-id={name} data-ctx-label={name}` from the row's outer `<div>` and add `onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, name }); }}`. New state `const [ctx, setCtx] = useState<{ x: number; y: number; name: string } | null>(null)`. A `ctxItems(name: string): CtxItem[]` function recomputes the derivations for `name` (lift the six lines from the top of `branchRow` into a small `rowFacts(name)` helper both use) and returns, in order:
```
⎇ Checkout                        when !current            → void checkout(name)
▸ Open worktree                   when !open && !isMerged  → onWorktreeSession(project, name, false)
▸ Attach session                  when open                → sess[0] ? onSelectSession(sess[0]) : onWorktreeSession(project, name, false)
⇉ Merge into  (children: one row per target) when open && !isMerged → void doMerge(name, target)
⧉ Copy branch name                                         → navigator.clipboard.writeText(name)
divider
✕ Delete branch  danger, hint "and its worktree" when open → setConfirmDel({ branch: name, path: wt?.path ?? "", sessCount: sess.length, hasWorktree: open })
```
Render `{ctx && <ContextMenu ctx={{ x: ctx.x, y: ctx.y, type: "branch", id: ctx.name, label: ctx.name }} items={ctxItems(ctx.name)} onClose={() => setCtx(null)} />}` next to the existing confirm card.

- [ ] **Step 2: Type-check, then probe**

Run: `npx tsc --noEmit -p tsconfig.app.json` → no errors. Probe as in Task 4 step 3: eval opens the Analyze modal (click the button whose text is `⊞ PROJECT`), clicks the `WORKTREES` tab button, dispatches `contextmenu` on the second branch row; capture; expected header `BRANCH <name>` with the rows above. Attach the crop.

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/WorktreesTab.tsx
git commit -m "dashboard: WORKTREES rows get the branch menu their data-ctx-type promised — checkout, open worktree, attach session, merge into, copy name, delete"
```

---

### Task 6: TASKS rows get a task menu

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` (`TasksTab` ~975-1200; the row at ~1096)

**Interfaces:**
- Consumes: `feedOne(t)`, `onShip(t)`, `openUpdate(t)`, `setOpen(key)`, `branchForTask(key, title)` (`lib/issuebranch`), `TrackerTask.url`.
- Produces: a component-built `<ContextMenu>` with `type: "task"`.

- [ ] **Step 1: Replace the dead registration with a local menu**

Remove the three `data-ctx-*` attributes from the task row and add the same `onContextMenu` pattern as Task 5 with state `{ x, y, key }`. `ctxItems(t: TrackerTask)`:
```
▸ Feed to Claude                                  → feedOne(t)
⑂ Ship it     hint `branch ${branchForTask(t.key, t.title)}` → onShip(t)
↗ Open in tracker   when t.url                    → window.open(t.url, "_blank", "noopener,noreferrer")
⧉ Copy key                                        → navigator.clipboard.writeText(t.key)
divider
⌁ Post update…                                    → setOpen(t.key); openUpdate(t)
```
Header label `t.key`. Render the `<ContextMenu>` inside `TasksTab`'s root.

- [ ] **Step 2: Type-check, then probe**

`npx tsc --noEmit -p tsconfig.app.json` → no errors. The live bridge has no tracker connection (memory: "no connection added yet"), so the TASKS list is empty headlessly; verify the row's handler by a focused read instead and say so in the hand-back. If a tracker is linked by then, probe like Task 5.

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx
git commit -m "dashboard: TASKS rows get the task menu their data-ctx-type promised — feed, ship it, open in tracker, copy key, post update"
```

---

### Task 7: The lightbox ignores right-clicks

**Files:**
- Modify: `bridge/dashboard/web/src/components/ImageLightbox.tsx` (`onUp` ~550, the video backdrop `onPointerDown` ~266)

- [ ] **Step 1: Guard both handlers**

In `onUp`, after `ptrs.current.delete(e.pointerId)` and the `spread` reset, add `if (e.button !== 0) return;` with a one-line comment: a right-click is for the menu, never a tap. In the video backdrop's `onPointerDown` guard the close with `e.button === 0 &&`.

- [ ] **Step 2: Probe**

Open a session with a screenshot in it (any recent turn with a WORK zone picture), click the thumbnail via eval to open the lightbox, dispatch `pointerdown` + `pointerup` with `button: 2` on the image, then read `document.querySelector('[data-ctxmenu]')` is null (no menu is opened by synthetic pointer events, that is expected) and that the image's transform did not change; dispatch the same on the backdrop and assert the lightbox is still mounted. Then dispatch `contextmenu` on the image and capture: expected a menu (type DASHBOARD until slice 2 adds `shot`) over an unzoomed picture. Attach the crop.

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/components/ImageLightbox.tsx
git commit -m "dashboard: a right-click in the lightbox opens the menu and nothing else — it used to zoom the picture or close the lightbox under the menu"
```

---

### Task 8: The Browser tail inside the native apps

**Files:**
- Modify: `bridge/dashboard/web/src/lib/nativeCtx.ts` (`nativeCtxItems`)

**Interfaces:**
- Consumes: `isNativeApp()` from `lib/mac.ts`.
- Produces: in Mystical.app / Mystical.exe the link row reads "Open link in browser", the image row "Open image in browser", and `page` has no Back / Forward rows. Elsewhere unchanged.

- [ ] **Step 1: Implement**

`const native = isNativeApp();` once at the top of `nativeCtxItems`; the two labels pick on it; build `page` then `filter` out Back and Forward when `native`. Update the module comment: why (URLPolicy sends new windows to the system browser; the shell has no history).

- [ ] **Step 2: Probe with the Mac user agent**

Same capture as Task 4 step 3 with `UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15 MysticalMac/1.0"` in the environment of `cdp.mjs`, dispatching `contextmenu` on a bare surface, then hovering the Browser › row (dispatch `mouseenter` on the button whose text starts with "Browser") before the second wait. Expected: the submenu shows Select all, Reload, Print… and no Back / Forward. Run once more without `UA`: Back and Forward are back. Attach the native crop.

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/lib/nativeCtx.ts
git commit -m "dashboard: inside Mystical.app the Browser tail drops Back/Forward (the shell has no history) and says 'Open … in browser', which is where a new window goes"
```

---

### Task 9: Verify, merge, ship

- [ ] **Step 1: Full checks in the worktree**

```bash
cd ~/Projects/.worktrees/mystical-assistant/feat-context-menus/bridge/dashboard/web && npm run build
for f in src/lib/editorctx.check.ts src/lib/mac.check.ts; do node --experimental-strip-types $f; done
cd ~/Projects/.worktrees/mystical-assistant/feat-context-menus && ~/.cache/mystical-test-venv/bin/python3 -m pytest tests/ -q
```
Expected: build clean, both checks print `done`, pytest green except the 7 known macOS-only failures (memory: mac-test-env).

- [ ] **Step 2: Merge to master and ship the dist**

Fast-forward merge `feat/context-menus` into `master` in the main checkout (merge-not-rebase if master moved; re-run the build after the merge). Copy the worktree-built `dist` over `bridge/dashboard/web/dist` in the launch checkout per the recipe in memory `dashboard-web-build-deploy.md` (dist is read per request: live on reload, no restart). Reload the dashboard and right-click the prompt box in Mystical.app: the EDITOR menu shows.

- [ ] **Step 3: The one thing a machine cannot check here**

Paste from the menu inside Mystical.app needs a real click with real clipboard content. After the dist copy, ask the user to copy a line of text, right-click the prompt box and tap Paste, then do the same with a screenshot on the clipboard. Record the result (pasted, or the ⌘V toast) in the hand-back and in memory, because it decides whether slice 2's screenshot "Attach to composer" can rely on the same path.

- [ ] **Step 4: Memory**

Write a memory note (`context-menus-slice-1.md`): what shipped, the registry id scheme (`composer` / `editor`), the probe recipe, and the Paste result once known. Link `[[dashboard-web-build-deploy]]`.
