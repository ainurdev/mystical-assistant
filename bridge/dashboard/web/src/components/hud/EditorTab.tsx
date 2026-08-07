import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsDownUp, ChevronsUpDown, FilePlus, Files, FolderPlus, RefreshCw, Search,
} from "lucide-react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { api, type FileContent, type GrepHit } from "../../api";
import { Markdown } from "../Markdown";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { chord } from "../../lib/chord";
import { cmpTreePath } from "../../lib/pathsort";
import { nextFocus, previewTabs, remapPaths, tabLabels, underPath } from "../../lib/tabs";
import { langFor } from "../../lib/langfor";
import { FileIcon } from "../../lib/fileicon";
import { symbolsIn } from "../../lib/symbols";
import { clampFont, loadPrefs, savePrefs, type EditorPrefs } from "../../lib/editorprefs";

/* EDITOR tab — a real file editor (not the diff viewer it used to be). Browses
   the whole working tree of the selected branch/worktree, opens any file into an
   editable CodeMirror 6 buffer with syntax highlighting, and saves to disk via
   Ctrl-S / :w (POST /local/files/write). Binary/oversized files load read-only
   with a placeholder.

   VS Code-ish extras: the activity bar picks the side view (EXPLORER tree ·
   SEARCH in files), a quick-open palette (Ctrl-P files · Ctrl-Shift-O symbols ·
   Ctrl-Shift-P commands), expand/collapse-all in the explorer,
   reveal-the-open-file, and new/rename/delete via right-click.

   One CMDS table below drives both the command palette and the key bindings, so
   the palette shows exactly what's bound. Keys follow VS Code where the browser
   allows it — Ctrl-N/Ctrl-W are reserved by the browser and can't be captured,
   so new-file and close-editor sit on Alt-N and Alt-W (Ctrl-F4 too).

   Formatting matches VS Code's defaults too: indent width per .editorconfig
   (falling back to each language's convention), trailing whitespace trimmed and
   a final newline added on save, and Shift-Alt-F to run the project's own
   formatter. The formatters run on the bridge — see bridge/fmt.py. */

export interface BranchOpt {
  name: string;
  on: boolean;
  hasWorktree: boolean;
}

interface Props {
  project: string;
  branch: string;
  branchOpts: BranchOpt[];
  onPickBranch: (b: string) => void;
  initialFile?: string; // opened straight away (sidebar FILES → editor modal)
}

// One row in the quick-open palette: a file, a symbol, or (`>` mode) a command.
interface PalItem {
  path: string;
  line?: number;
  label: string;
  sub: string;
  run?: () => void;
}

// A command: one entry in the Ctrl-Shift-P palette and, with `key`, one binding.
interface Cmd {
  label: string;
  key?: string;   // VS Code notation — "Ctrl+Shift+F", "Shift+Alt+F", "F2"
  alt?: string;   // second binding, matched but not shown
  run: () => void;
  off?: boolean;  // hidden from the palette when it can't run
}

export interface TreeRow {
  key: string;
  dir: boolean;
  depth: number;
  name: string;
  path: string;
}

/* Flatten a sorted path list into a collapsible directory tree (dirs before
   their files, honoring the collapsed set). */
export function buildRows(paths: string[], collapsed: Set<string>): TreeRow[] {
  const sorted = [...paths].sort(cmpTreePath);
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  for (const path of sorted) {
    const parts = path.split("/");
    let prefix = "";
    let hidden = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (!hidden && !seen.has(p)) {
        seen.add(p);
        rows.push({ key: `d:${p}`, dir: true, depth: i, name: parts[i], path: p });
      }
      if (collapsed.has(p)) hidden = true;
      prefix = p;
    }
    if (!hidden) rows.push({ key: `f:${path}`, dir: false, depth: parts.length - 1, name: parts[parts.length - 1] ?? path, path });
  }
  return rows;
}

/* Every directory that appears in the path list — the expand/collapse-all set. */
export function dirsOf(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      out.add(prefix);
    }
  }
  return [...out];
}

/* Subsequence match, VS Code Ctrl-P style: every query char in order, gaps
   penalized, name matches beating directory matches. -1 = no match. */
function fuzzyScore(q: string, path: string): number {
  const s = path.toLowerCase();
  let from = 0;
  let score = 0;
  let last = -1;
  for (const c of q) {
    const at = s.indexOf(c, from);
    if (at < 0) return -1;
    score += at - last - 1;
    last = at;
    from = at + 1;
  }
  return score + (last < path.lastIndexOf("/") + 1 ? 40 : 0);
}

// Swapped in once the open file's language chunk has loaded (see langFor).
const langComp = new Compartment();
// Reconfigured live when the prefs change, so a toggle doesn't rebuild the buffer.
const wrapComp = new Compartment();
const fontComp = new Compartment();

/* Put line `n` in the middle of the viewport with the cursor on it. */
function gotoLine(view: EditorView, n: number) {
  const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
  view.focus();
}

// CRT-flavored syntax colors + a transparent editor chrome, so the buffer sits
// on the panel's own dark background rather than CodeMirror's default light one.
const crtHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--purple)" },
  { tag: [t.name, t.propertyName, t.macroName, t.deleted, t.character], color: "var(--txh)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--acc)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name), t.bool], color: "var(--ok)" },
  { tag: [t.typeName, t.className, t.number, t.annotation, t.modifier, t.self, t.namespace], color: "var(--warn)" },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link], color: "var(--acc)" },
  { tag: [t.meta, t.comment], color: "var(--txd)", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.string, t.inserted, t.special(t.string)], color: "var(--ok)" },
  { tag: t.invalid, color: "var(--err)" },
]);

const crtTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--txh)", height: "100%", fontSize: "var(--t12)" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "'JetBrains Mono',monospace", caretColor: "var(--acc)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--acc)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--acc) 18%, transparent)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--txg)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--acc) 4.5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--txd)" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono',monospace", lineHeight: "1.6" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--purple) 15%, transparent)" },
  // basicSetup's own chrome — find/replace panel, completion popup, fold arrows.
  // Without these they'd render in CodeMirror's stock dark, next to the CRT.
  ".cm-panels": { backgroundColor: "color-mix(in srgb, var(--panel2) 98%, transparent)", color: "var(--txh)", border: "none" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)",
  },
  ".cm-panel.cm-search input": {
    background: "color-mix(in srgb, var(--panel3) 60%, transparent)", color: "var(--txb)",
    border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", outline: "none", padding: "2px 5px",
  },
  ".cm-panel.cm-search button": {
    background: "transparent", color: "var(--txm)", cursor: "pointer",
    border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", padding: "2px 7px",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 22%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--acc) 32%, transparent)" },
  ".cm-tooltip": {
    background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
    border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", color: "var(--txh)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "color-mix(in srgb, var(--acc) 16%, transparent)", color: "var(--txb)",
  },
  ".cm-foldGutter span": { color: "var(--txd)" },
  ".cm-foldPlaceholder": {
    background: "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txm)",
    border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
  },
}, { dark: true });

export function EditorTab({ project, branch, branchOpts, onPickBranch, initialFile }: Props) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [paths, setPaths] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<string[]>([]);             // open buffers, left to right
  const [peek, setPeek] = useState<string | null>(null);      // the preview tab, if any (see peekTab)
  const [open, setOpen] = useState<string | null>(null);      // path being edited
  const [meta, setMeta] = useState<FileContent | null>(null); // load result (binary/too_large flags)
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fmting, setFmting] = useState(false);
  const [lang, setLang] = useState("");   // detected language, shown in the status bar
  const [cmd, setCmd] = useState("");
  const [note, setNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Markdown preview: the rendered text, or null while editing. Holding the text
  // (not a bool) lets the CodeMirror view stay mounted underneath, so toggling
  // back never loses unsaved edits.
  const [preview, setPreview] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<EditorPrefs>(loadPrefs);
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  // quick-open palette: null = closed; "" files, "@…" symbols, ">…" commands
  const [palQ, setPalQ] = useState<string | null>(null);
  const [palIdx, setPalIdx] = useState(0);
  // activity bar: which side view is showing, and whether the side bar is open
  // at all (Ctrl-B, or clicking the active icon — VS Code's own toggle).
  const [view, setView] = useState<"explorer" | "search">("explorer");
  const [sideOpen, setSideOpen] = useState(true);
  const [sideW, setSideW] = useState(230);   // dragged on the border, see the handle below
  const [searchQ, setSearchQ] = useState("");
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [grepBusy, setGrepBusy] = useState(false);
  // explorer file management: right-click menu + the new/rename input bar
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);      // row being dragged
  const [dropDir, setDropDir] = useState<string | null>(null); // folder under the cursor
  const [edit, setEdit] = useState<{ mode: "new" | "newdir" | "rename"; path: string; value: string } | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // One entry per open tab: the load result, the buffer text as it was when we
  // switched away, the on-disk content, and the full CodeMirror state. Switching
  // tabs tears the view down, so without `state` every switch would lose the
  // undo history, the folds and the cursor along with any unsaved edits.
  const bufs = useRef(new Map<string, { meta: FileContent; text: string; base: string; state?: EditorState }>());
  const baseRef = useRef("");                     // last-saved content, for the dirty check
  const saveRef = useRef<() => void>(() => {});   // latest save fn, for the Ctrl-S keymap
  const fmtRef = useRef<() => void>(() => {});    // ditto for Shift-Alt-F
  const noteT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpRef = useRef(0);                      // line to scroll to once the buffer mounts
  const rowRef = useRef<HTMLButtonElement | null>(null); // the open file's tree row
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {}); // latest key handler (see CMDS)

  function flash(m: string) {
    setNote(m);
    if (noteT.current) clearTimeout(noteT.current);
    noteT.current = setTimeout(() => setNote(""), 3000);
  }
  useEffect(() => () => { if (noteT.current) clearTimeout(noteT.current); }, []);

  const loadTree = () =>
    api.filesTree(project, branch || undefined)
      .then((r) => setPaths(r.files))
      .catch(() => setPaths([]));

  // Load the file list whenever the project/branch changes. An `initialFile`
  // (opened from the sidebar explorer) starts open — its ancestors are the one
  // exception to folders-start-closed, so its row renders and the
  // scroll-into-view below reveals it.
  useEffect(() => {
    let live = true;
    // A different project/branch is a different working tree — the old buffers
    // no longer describe anything on disk, so they go.
    bufs.current.clear();
    setTabs(initialFile ? [initialFile] : []); setPeek(null);
    setOpen(initialFile ?? null); setMeta(null);
    void api.filesTree(project, branch || undefined)
      .then((r) => {
        if (!live) return;
        setPaths(r.files);
        // Closed by default — a repo tree fully expanded is thousands of rows
        // to scroll past before reaching anything.
        setCollapsed(new Set(dirsOf(r.files).filter((d) => !initialFile || !underPath(d, initialFile))));
      })
      .catch(() => { if (live) setPaths([]); });
    return () => { live = false; };
  }, [project, branch, initialFile]);

  const labels = useMemo(() => tabLabels(tabs), [tabs]);
  const rows = useMemo(() => buildRows(paths, collapsed), [paths, collapsed]);
  const dirs = useMemo(() => dirsOf(paths), [paths]);
  const allCollapsed = dirs.length > 0 && collapsed.size >= dirs.length;

  // Keep the open file's row visible when it's opened from the palette.
  useEffect(() => { rowRef.current?.scrollIntoView({ block: "nearest" }); }, [open, rows]);

  // Load a file's contents when `open` changes — or restore them from the tab's
  // buffer, which is both faster and the only way unsaved edits survive.
  useEffect(() => {
    if (!open) { setMeta(null); return; }
    const cached = bufs.current.get(open);
    if (cached) {
      setMeta(cached.meta); baseRef.current = cached.base;
      setDirty(cached.text !== cached.base); setPreview(null);
      return;
    }
    let live = true;
    setMeta(null); setDirty(false); setPreview(null);
    void api.fileRead(project, open, branch || undefined)
      .then((r) => {
        if (!live) return;
        const text = r.content ?? "";
        if (r.ok) bufs.current.set(open, { meta: r, text, base: text });
        setMeta(r); baseRef.current = text;
      })
      .catch((e) => { if (live) setMeta({ ok: false, error: (e as Error).message }); });
    return () => { live = false; };
  }, [open, project, branch]);

  const editable = !!meta && meta.ok && !meta.binary && !meta.too_large;
  const isMd = !!open && /\.(md|markdown)$/i.test(open);

  // (Re)build the CodeMirror view when an editable file's contents arrive.
  useEffect(() => {
    if (!hostRef.current || !editable || !open || !meta) {
      if (meta && !editable) jumpRef.current = 0;   // binary/too large: no line to jump to
      return;
    }
    const fresh = EditorState.create({
      doc: bufs.current.get(open)?.text ?? meta.content ?? "",
      extensions: [
        // Ours before basicSetup — earlier extensions take precedence, so the
        // CRT palette beats its default highlight style and Ctrl-S beats the
        // browser's Save Page.
        Prec.highest(keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { saveRef.current(); return true; } },
          { key: "Shift-Alt-f", preventDefault: true, run: () => { fmtRef.current(); return true; } },
        ])),
        syntaxHighlighting(crtHighlight),
        // Line numbers, history, folding, bracket close/match, autocomplete,
        // find-and-replace, selection-match highlighting, multiple selections.
        basicSetup,
        keymap.of([indentWithTab]),
        // Indent width comes from the project's .editorconfig where it has one,
        // otherwise the language's convention (4 for Python/PHP, tabs for Go) —
        // resolved server-side in bridge/fmt.py and shipped with the content.
        indentUnit.of(meta.indent ?? "  "),
        EditorState.tabSize.of(meta.tab_size ?? 2),
        crtTheme,
        wrapComp.of(prefs.wordWrap ? EditorView.lineWrapping : []),
        fontComp.of(EditorView.theme({ "&": { fontSize: `${prefs.fontSize}px` } })),
        langComp.of([]),   // filled in below, once the language chunk lands
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          setDirty(u.state.doc.toString() !== baseRef.current);
          setPeek((p) => (p === open ? null : p));   // editing a preview keeps it, VS Code-style
        }),
      ],
    });
    // A tab we've been in before comes back with its history, folds and cursor —
    // and with whatever its compartments already held, which is why Tasks 5 and 6
    // check `cachedState` before configuring one again.
    const cachedState = bufs.current.get(open)?.state;
    const state = cachedState ?? fresh;
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    view.focus();
    // Highlighting arrives a tick later: the language is a lazy chunk, so the
    // buffer renders plain and repaints when it loads (guard = view still live).
    const desc = langFor(open);
    setLang(desc?.name ?? "plain text");
    void desc?.load().then((sup) => {
      if (viewRef.current === view) view.dispatch({ effects: langComp.reconfigure(sup) });
    }).catch(() => {
      // LanguageDescription caches a rejected load for the life of the page, so
      // one failed chunk fetch means this language stays plain until a reload.
      // Say so instead of leaving an unexplained colourless buffer.
      if (viewRef.current === view) {
        setLang(`${desc?.name ?? "?"} — load failed`);
        flash(`E485: ${desc?.name} highlighting failed to load — reload the page`);
      }
    });
    if (jumpRef.current) { gotoLine(view, jumpRef.current); jumpRef.current = 0; }
    return () => {
      // Stash the buffer on the way out so switching tabs keeps unsaved edits,
      // the undo history and the cursor.
      const b = bufs.current.get(open);
      if (b) { b.text = view.state.doc.toString(); b.state = view.state; }
      view.destroy(); viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, open, meta]);

  // Prefs change far more often than files do — reconfigure in place rather than
  // rebuilding the buffer, which would drop the cursor.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: [
      wrapComp.reconfigure(prefs.wordWrap ? EditorView.lineWrapping : []),
      fontComp.reconfigure(EditorView.theme({ "&": { fontSize: `${prefs.fontSize}px` } })),
    ] });
  }, [prefs.wordWrap, prefs.fontSize]);

  /* Replace the whole buffer in one transaction, keeping the cursor where it
     was — used by both save-time cleanup and the formatter. */
  function replaceDoc(v: EditorView, text: string) {
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      selection: { anchor: Math.min(v.state.selection.main.head, text.length) },
    });
  }

  /* The two save-time fixups VS Code does by default, both overridable per
     project through .editorconfig. */
  function tidy(text: string): string {
    const out = meta?.trim_trailing_whitespace === false ? text : text.replace(/[ \t]+$/gm, "");
    return meta?.insert_final_newline === false || out === "" || out.endsWith("\n") ? out : `${out}\n`;
  }

  async function save() {
    const v = viewRef.current;
    if (!v || !open || saving) return;
    // Format first when asked — format() swaps the buffer, and the read below
    // picks the result up. A formatter failure only flashes; the save still runs.
    if (prefs.formatOnSave && meta?.formatter !== false) await format();
    const raw = v.state.doc.toString();
    const content = tidy(raw);
    if (content !== raw) replaceDoc(v, content);   // keep the buffer equal to disk
    setSaving(true);
    try {
      const r = await api.fileWrite(project, open, content, branch || undefined);
      if (r.ok) {
        baseRef.current = content;
        const b = bufs.current.get(open);
        if (b) { b.text = content; b.base = content; b.state = v.state; }
        setDirty(false); flash(`wrote ${open}`);
      }
      else flash(`E212: ${r.error || "write failed"}`);
    } catch (e) {
      flash(`E212: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = () => { void save(); };

  /* Format the buffer with whatever the project actually uses — prettier from
     its node_modules, ruff/black, gofmt, rustfmt, php-cs-fixer. The tools run
     on the bridge (see bridge/fmt.py), so their config files resolve and no
     formatter has to be bundled into the page. Nothing is written to disk;
     the user still saves. */
  async function format() {
    const v = viewRef.current;
    if (!v || !open || fmting) return;
    const before = v.state.doc.toString();
    setFmting(true);
    try {
      const r = await api.fileFormat(project, open, before, branch || undefined);
      if (!r.ok || typeof r.content !== "string") flash(`E495: ${r.error || "format failed"}`);
      else if (r.content === before) flash(`already formatted · ${r.tool}`);
      else { replaceDoc(v, r.content); flash(`formatted with ${r.tool}`); }
    } catch (e) {
      flash(`E495: ${(e as Error).message}`);
    } finally {
      setFmting(false);
    }
  }
  fmtRef.current = () => { void format(); };

  /* ---- tabs ---- */

  // Open a file in a tab for keeps (reusing its tab if it already has one) and
  // focus it — the palette, `new file`, and a double-click all land here.
  function openTab(path: string) {
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]));
    setPeek((p) => (p === path ? null : p));
    setOpen(path);
  }

  /* A single click in the explorer: VS Code's preview tab. One reusable slot, so
     browsing files doesn't leave a strip of tabs behind. Double-clicking the row
     or the tab, or editing the buffer, promotes it to a tab that stays. */
  function peekTab(path: string) {
    if (path === open) return;
    if (!tabs.includes(path)) {
      // The slot's buffer goes with it — it can't hold unsaved edits, since the
      // first keystroke promotes the tab.
      if (peek) bufs.current.delete(peek);
      setTabs((ts) => previewTabs(ts, peek, path));
      setPeek(path);
    }
    setOpen(path);
  }

  /* Unsaved edits? The open tab's live text lives in the CodeMirror view and
     only lands in `bufs` when we switch away, so it answers from `dirty`. */
  function isDirty(path: string) {
    if (path === open) return dirty;
    const b = bufs.current.get(path);
    return !!b && b.text !== b.base;
  }

  function closeTab(path: string) {
    if (isDirty(path) && !window.confirm(`${path} has unsaved changes — close it anyway?`)) return;
    bufs.current.delete(path);
    const rest = tabs.filter((p) => p !== path);
    setTabs(rest);
    setPeek((p) => (p === path ? null : p));
    if (path === open) setOpen(nextFocus(tabs, path, rest));
  }

  function closeAll() {
    const unsaved = tabs.filter(isDirty).length;
    if (unsaved && !window.confirm(`${unsaved} open file${unsaved === 1 ? " has" : "s have"} unsaved changes — close anyway?`)) return;
    bufs.current.clear();
    setTabs([]); setPeek(null); setOpen(null);
  }

  /* Follow a rename (or a delete, with `to` null) through the tab strip and the
     buffer cache, subtree included, so unsaved edits move with the file. */
  function remapTabs(from: string, to: string | null) {
    for (const [p, b] of [...bufs.current]) {
      if (!underPath(from, p)) continue;
      bufs.current.delete(p);
      if (to !== null) bufs.current.set(to + p.slice(from.length), b);
    }
    const rest = remapPaths(tabs, from, to);
    setTabs(rest);
    setPeek((p) => (p && underPath(from, p) ? (to === null ? null : to + p.slice(from.length)) : p));
    return rest;
  }

  /* ---- side views ---- */

  // The activity bar's job — the view, plus opening the bar to show it.
  function showView(v: "explorer" | "search") { setView(v); setSideOpen(true); }

  /* Drag the side bar's right edge — deep paths and long file names don't fit
     230px. Pointer capture keeps the drag alive over the CodeMirror buffer;
     double-click puts it back. */
  function onResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const x0 = e.clientX;
    const w0 = sideW;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSideW(Math.min(560, Math.max(140, w0 + ev.clientX - x0)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  /* The new/rename input sits in the explorer, so a command that opens it has
     to bring the explorer back first. */
  function beginEdit(e: NonNullable<typeof edit>) { showView("explorer"); setEdit(e); }

  /* ---- quick-open palette ---- */

  // Expand every ancestor of `path` so its row is actually rendered.
  function reveal(path: string) {
    setCollapsed((c) => {
      const n = new Set(c);
      const parts = path.split("/");
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        n.delete(prefix);
      }
      return n;
    });
  }

  function openFile(path: string, line?: number) {
    setPalQ(null);
    reveal(path);
    if (path === open) {
      if (line && viewRef.current) gotoLine(viewRef.current, line);
      return;
    }
    jumpRef.current = line ?? 0;
    openTab(path);
  }

  const palMode = palQ === null ? "" : palQ.startsWith("@") ? "@" : palQ.startsWith(">") ? ">" : "p";
  const palTerm = palMode === "p" ? (palQ ?? "") : (palQ ?? "").slice(1);

  // SEARCH view — `git grep` on the bridge, debounced so typing isn't a search
  // per keystroke.
  useEffect(() => {
    const q = searchQ.trim();
    if (q.length < 2) { setHits([]); setGrepBusy(false); return; }
    let live = true;
    setGrepBusy(true);
    const t = setTimeout(() => {
      void api.filesGrep(project, q, branch || undefined)
        .then((r) => { if (live) setHits(r.hits); })
        .catch(() => { if (live) setHits([]); })
        .finally(() => { if (live) setGrepBusy(false); });
    }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [searchQ, project, branch]);

  // Hits by file, VS Code's search tree: a file header, then its matching lines.
  const hitGroups = useMemo(() => {
    const m = new Map<string, GrepHit[]>();
    for (const h of hits) {
      const list = m.get(h.path);
      if (list) list.push(h);
      else m.set(h.path, [h]);
    }
    return [...m];
  }, [hits]);

  // Walk the syntax tree once when `@` mode opens, not per keystroke — on a big
  // file the first walk has to wait for the parse.
  const outline = useMemo(
    () => (palMode === "@" && viewRef.current ? symbolsIn(viewRef.current.state) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palMode, open],
  );

  /* Every editor action, in one table: the Ctrl-Shift-P palette lists these and
     the key handler below matches `key`/`alt` against the event's chord, so a
     binding can't drift from what the palette advertises. */
  const CMDS: Cmd[] = [
    { label: "Go to File…", key: "Ctrl+P", run: () => setPalQ("") },
    { label: "Go to Symbol in Editor…", key: "Ctrl+Shift+O", run: () => setPalQ("@"), off: !editable },
    { label: "Show All Commands", key: "Ctrl+Shift+P", run: () => setPalQ(">") },
    { label: "New File…", key: "Alt+N", run: () => startNew("new", open ?? "", !open) },
    { label: "New Folder…", key: "Shift+Alt+N", run: () => startNew("newdir", open ?? "", !open) },
    { label: "Rename File…", key: "F2", off: !open,
      run: () => { if (open) beginEdit({ mode: "rename", path: open, value: open }); } },
    { label: "Save", key: "Ctrl+S", run: () => void save(), off: !editable },
    { label: "Format Document", key: "Shift+Alt+F", run: () => void format(), off: !editable || meta?.formatter === false },
    { label: "Close Editor", key: "Ctrl+F4", alt: "Alt+W", off: !open, run: () => { if (open) closeTab(open); } },
    { label: "Close All Editors", off: !tabs.length, run: closeAll },
    { label: "Show Explorer", key: "Ctrl+Shift+E", run: () => { showView("explorer"); if (open) reveal(open); } },
    { label: "Find in Files", key: "Ctrl+Shift+F", run: () => showView("search") },
    { label: "Toggle Side Bar", key: "Ctrl+B", run: () => setSideOpen((o) => !o) },
    { label: allCollapsed ? "Expand Folders in Explorer" : "Collapse Folders in Explorer",
      run: () => { showView("explorer"); setCollapsed(allCollapsed ? new Set() : new Set(dirs)); } },
    { label: "Refresh Explorer", run: () => void loadTree() },
    { label: preview === null ? "Open Markdown Preview" : "Back to the Editor", off: !editable || !isMd,
      run: () => setPreview((p) => (p === null ? viewRef.current?.state.doc.toString() ?? meta?.content ?? "" : null)) },
    { label: `Format on Save — ${prefs.formatOnSave ? "on" : "off"}`,
      run: () => setPrefs((p) => ({ ...p, formatOnSave: !p.formatOnSave })) },
    { label: `Toggle Word Wrap — ${prefs.wordWrap ? "on" : "off"}`, key: "Alt+Z",
      run: () => setPrefs((p) => ({ ...p, wordWrap: !p.wordWrap })) },
    { label: "Increase Font Size", key: "Ctrl+=", alt: "Ctrl++",
      run: () => setPrefs((p) => ({ ...p, fontSize: clampFont(p.fontSize + 1) })) },
    { label: "Decrease Font Size", key: "Ctrl+-",
      run: () => setPrefs((p) => ({ ...p, fontSize: clampFont(p.fontSize - 1) })) },
  ];

  const palItems = useMemo<PalItem[]>(() => {
    if (palQ === null || palMode === ">") return [];
    const q = palTerm.trim().toLowerCase();
    if (palMode === "@") {
      if (!open) return [];
      return outline
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .map((s) => ({ path: open, line: s.line, label: s.name, sub: `${s.kind} · line ${s.line}` }));
    }
    const scored = paths
      .map((p) => ({ p, score: q ? fuzzyScore(q, p) : 0 }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.p.length - b.p.length)
      .slice(0, 60);
    return scored.map(({ p }) => ({ path: p, label: p.split("/").pop() ?? p, sub: p }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palQ, palMode, palTerm, paths, open, outline]);

  /* Sixteen commands are cheap to filter, and their closures have to be this
     render's — so `>` mode skips the memo the file list needs. */
  const palRows: PalItem[] = palMode !== ">" ? palItems
    : CMDS.filter((c) => !c.off && c.label.toLowerCase().includes(palTerm.trim().toLowerCase()))
      .map((c) => ({ path: "", label: c.label, sub: c.key ?? "", run: c.run }));

  useEffect(() => { setPalIdx(0); }, [palQ]);

  /* The bindings, matched against CMDS. Captured on window, so Ctrl-S beats the
     browser's Save Page and the palette's Escape doesn't close the whole modal.
     Held in a ref and rebuilt each render: the listener is registered once, but
     every command still runs against current state. */
  keyRef.current = (e: KeyboardEvent) => {
    if (e.key === "Escape" && palQ !== null) { e.preventDefault(); e.stopPropagation(); setPalQ(null); return; }
    // A bare F-key belongs to whatever field is being typed in, not to us.
    const el = e.target as HTMLElement | null;
    if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    const ch = chord(e);
    const cmd = CMDS.find((c) => c.key === ch || c.alt === ch);
    if (!cmd) return;
    // Swallowed even when the command can't run — Ctrl-S must never reach the
    // browser's Save Page just because the open file is binary.
    e.preventDefault();
    e.stopPropagation();
    if (!cmd.off) cmd.run();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  function runPal(it: PalItem) {
    if (it.run) { setPalQ(null); it.run(); }
    else openFile(it.path, it.line);
  }

  function onPalKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setPalIdx((i) => Math.min(i + 1, palRows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPalIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      const it = palRows[palIdx];
      if (it) runPal(it);
    }
  }

  /* ---- explorer file management ---- */

  async function runOp(op: "new" | "newdir" | "rename" | "delete", path: string, to?: string) {
    try {
      const r = await api.fileOp(project, op, path, to, branch || undefined);
      if (!r.ok) { flash(`E212: ${r.error || "failed"}`); return; }
      await loadTree();
      if (op === "rename" && to) {
        remapTabs(path, to);
        if (open === path) setOpen(to);
        else if (open?.startsWith(`${path}/`)) setOpen(`${to}${open.slice(path.length)}`);
        flash(`renamed to ${to}`);
      } else if (op === "delete") {
        const rest = remapTabs(path, null);
        if (open && underPath(path, open)) setOpen(nextFocus(tabs, open, rest));
        flash(`deleted ${path}`);
      } else if (op === "new") {
        reveal(path);
        openTab(path);
      } else {
        // The tree comes from `git ls-files`, which can't see an empty folder —
        // so hand the user straight to "new file inside it".
        beginEdit({ mode: "new", path, value: `${path}/` });
        flash(`created ${path}/ — add a file to it`);
      }
    } catch (e) {
      flash(`E212: ${(e as Error).message}`);
    }
  }

  // New file/folder go next to the clicked file, or inside the clicked folder.
  function startNew(mode: "new" | "newdir", anchor: string, dir: boolean) {
    const base = dir ? anchor : anchor.includes("/") ? anchor.slice(0, anchor.lastIndexOf("/")) : "";
    beginEdit({ mode, path: base, value: base ? `${base}/` : "" });
  }

  function submitEdit() {
    if (!edit) return;
    const v = edit.value.trim().replace(/^\/+/, "");
    setEdit(null);
    if (!v) return;
    if (edit.mode === "rename") { if (v !== edit.path) void runOp("rename", edit.path, v); }
    else void runOp(edit.mode, v);
  }

  function ctxItems(target: { path: string; dir: boolean }): CtxItem[] {
    const head: CtxItem[] = [
      { icon: "+", label: "New File…", hint: "Alt+N", onClick: () => startNew("new", target.path, target.dir) },
      { icon: "▤", label: "New Folder…", hint: "⇧Alt+N", onClick: () => startNew("newdir", target.path, target.dir) },
    ];
    if (!target.path) return head;   // right-click on empty space → repo root
    return [
      ...head,
      { divider: true },
      { icon: "✎", label: "Rename…", hint: "F2", onClick: () => beginEdit({ mode: "rename", path: target.path, value: target.path }) },
      { icon: "⧉", label: "Copy Path", onClick: () => void navigator.clipboard?.writeText(target.path).then(() => flash("path copied")).catch(() => {}) },
      { divider: true },
      {
        icon: "✕", label: "Delete", danger: true, hint: target.dir ? "DIR" : undefined,
        onClick: () => {
          if (window.confirm(`Delete ${target.path}${target.dir ? " and everything in it" : ""}?`)) void runOp("delete", target.path);
        },
      },
    ];
  }

  /* ---- drag to move (a rename under the hood) ---- */

  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  // No dropping a folder into itself or its own subtree, and no no-op moves.
  const canDrop = (dest: string) =>
    drag !== null && dest !== drag && !dest.startsWith(`${drag}/`) && dest !== parentOf(drag);

  function onDropInto(e: React.DragEvent, dest: string) {
    e.preventDefault();
    e.stopPropagation();
    const src = drag;
    setDrag(null); setDropDir(null);
    if (!src || !canDrop(dest)) return;
    const name = src.split("/").pop() ?? src;
    void runOp("rename", src, dest ? `${dest}/${name}` : name);
  }

  function dragTargetProps(dest: string) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!canDrop(dest)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropDir(dest);
      },
      onDrop: (e: React.DragEvent) => onDropInto(e, dest),
    };
  }

  function dragSourceProps(path: string) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", path); setDrag(path); },
      onDragEnd: () => { setDrag(null); setDropDir(null); },
    };
  }

  function onRowCtx(e: React.MouseEvent, path: string, dir: boolean) {
    e.preventDefault();
    e.stopPropagation();   // the dashboard's own right-click menu listens on window
    setCtx({ x: e.clientX, y: e.clientY, path, dir });
  }

  function onCmdKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const c = cmd.trim().replace(/^:/, "");
    setCmd("");
    if (c === "w" || c === "write" || c === "wq" || c === "x") void save();
    else if (c === "fmt" || c === "format") void format();
    else if (c) flash(`E492: not an editor command: ${c}`);
  }

  const lineCount = editable ? (meta?.content ?? "").split("\n").length : 0;
  // Indent shown the way VS Code shows it, so a wrong .editorconfig is visible.
  const indentLabel = meta?.indent === "\t" ? "tab" : `${meta?.tab_size ?? 2} spaces`;
  const statusRight = note
    || (meta && !meta.ok ? (meta.error || "can't open") : "")
    || (meta?.image ? `image · ${Math.round((meta.size ?? 0) / 1024)} KB`
      : meta?.binary ? "binary file" : meta?.too_large ? "too large to edit"
      : editable ? `${lang || "…"} · ${indentLabel} · utf-8 · ${lineCount}L` : "");

  return (
    <div style={{ animation: "mslide .3s ease both", height: "100%" }}>
      {/* Fills the modal body exactly — no floor. A floor taller than the body
          made the whole modal scroll, so a long file list pushed the buffer out
          of view; explorer and buffer now scroll inside their own columns. */}
      <div style={{ position: "relative", display: "grid", gridTemplateColumns: `42px ${sideOpen ? `${sideW}px ` : ""}1fr`, border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", height: "100%", minHeight: 0, overflow: "hidden" }}>
        {/* activity bar — VS Code's icon rail: picks the side view, and clicking
            the one already showing collapses the bar (same as Ctrl-B). */}
        <div style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4, gap: 2, background: "color-mix(in srgb, var(--panel2) 55%, transparent)" }}>
          {([
            { k: "explorer", I: Files, t: "Explorer · Ctrl-Shift-E" },
            { k: "search", I: Search, t: "Search in files · Ctrl-Shift-F" },
          ] as const).map(({ k, I, t }) => {
            const on = sideOpen && view === k;
            return (
              <button key={k} title={t} aria-label={t} {...hp(`act:${k}`)}
                onClick={() => (on ? setSideOpen(false) : showView(k))}
                style={{ position: "relative", appearance: "none", cursor: "pointer", border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: "transparent", width: 42, height: 40, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, color: on ? "var(--txb)" : hov === `act:${k}` ? "var(--txh)" : "var(--txd)" }}>
                <I size={17} strokeWidth={1.6} style={{ marginLeft: -2 }} />
                {/* results waiting behind a view you're not looking at */}
                {k === "search" && hits.length > 0 && !on && (
                  <span style={{ position: "absolute", top: 7, right: 7, width: 5, height: 5, borderRadius: "50%", background: "var(--acc)" }} />
                )}
              </button>
            );
          })}
        </div>
        {/* side view — explorer tree or search-in-files */}
        {sideOpen && (
        <div style={{ position: "relative", borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", minHeight: 0, background: "color-mix(in srgb, var(--panel2) 35%, transparent)" }}>
          {/* the grabbable border between the side bar and the buffer */}
          <div onPointerDown={onResizeDown} onDoubleClick={() => setSideW(230)} title="drag to resize · double-click to reset"
            {...hp("rsz")}
            style={{ position: "absolute", top: 0, bottom: 0, right: -3, width: 7, zIndex: 6, cursor: "col-resize", background: hov === "rsz" ? "color-mix(in srgb, var(--acc) 35%, transparent)" : "transparent" }} />
          {view === "search" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px", flex: "none" }}>
                <span style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)" }}>SEARCH</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txl)" }}>
                  {grepBusy ? "…" : hits.length ? `${hits.length} in ${hitGroups.length}` : ""}
                </span>
              </div>
              <div style={{ padding: "0 8px 8px", flex: "none" }}>
                <input autoFocus value={searchQ} onChange={(e) => setSearchQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setSearchQ(""); } }}
                  placeholder="search in files…"
                  style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", padding: "5px 7px" }} />
              </div>
              <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 8 }}>
                {hitGroups.length === 0 && (
                  <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 10px", fontFamily: "'JetBrains Mono',monospace" }}>
                    {searchQ.trim().length < 2 ? "Type at least 2 characters." : grepBusy ? "…" : "No results."}
                  </div>
                )}
                <div className="vskip-row">
                {hitGroups.map(([path, list]) => (
                  <div key={path}>
                    <div title={path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px 3px", fontFamily: "'JetBrains Mono',monospace" }}>
                      <FileIcon name={path} size={12} />
                      <span style={{ fontSize: "var(--t105)", color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{path.split("/").pop()}</span>
                      <span style={{ fontSize: "var(--t9)", color: "var(--txl)", flex: "none" }}>{list.length}</span>
                    </div>
                    {list.map((h) => (
                      <button key={`${h.line}:${h.text}`} className="trow" onClick={() => openFile(h.path, h.line)} title={`${h.path}:${h.line}`}
                        style={{ width: "100%", appearance: "none", border: 0, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "baseline", gap: 7, padding: "2px 8px 2px 22px" }}>
                        <span style={{ fontSize: "var(--t9)", color: "var(--txg)", flex: "none" }}>{h.line}</span>
                        <span style={{ fontSize: "var(--t10)", color: "var(--txm)", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{h.text.trim()}</span>
                      </button>
                    ))}
                  </div>
                ))}
                </div>
              </div>
            </>
          ) : (
          <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px", flex: "none" }}>
            <span style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>EXPLORER · {paths.length}</span>
            <span style={{ flex: 1 }} />
            <div style={{ position: "relative", flex: "none" }}>
              <button onClick={() => setMenuOpen((o) => !o)} title="switch branch — worktrees marked" {...hp("br")}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === "br" ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", padding: "3px 7px", maxWidth: 150 }}>
                <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch || "—"}</span>
                <span style={{ color: "var(--purple-g)", flex: "none" }}>▾</span>
              </button>
              {menuOpen && (
                <div style={{ position: "absolute", top: "calc(100% + 5px)", left: 0, zIndex: 30, minWidth: 210, border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 12px 32px var(--shadow-pop)", padding: 5, animation: "mslide .16s ease both" }}>
                  <div style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", padding: "5px 8px 7px" }}>SWITCH BRANCH</div>
                  {branchOpts.map((b) => (
                    <button key={b.name} onClick={() => { onPickBranch(b.name); setMenuOpen(false); }} {...hp(`bi:${b.name}`)}
                      style={{ width: "100%", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: 0, background: hov === `bi:${b.name}` ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", padding: "7px 9px", textAlign: "left" }}>
                      <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                      {b.hasWorktree && <span style={{ fontSize: "var(--t75)", letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", padding: "1px 4px", flex: "none" }}>WORKTREE</span>}
                      {b.on && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* explorer toolbar — VS Code's own four: new file · new folder ·
              refresh · collapse all. Everything else is in Ctrl-Shift-P. */}
          <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 8px 7px", flex: "none" }}>
            {([
              { k: "nf", I: FilePlus, t: "New File… · Alt-N", on: () => startNew("new", "", true) },
              { k: "nd", I: FolderPlus, t: "New Folder… · Shift-Alt-N", on: () => startNew("newdir", "", true) },
              { k: "ref", I: RefreshCw, t: "Refresh Explorer", on: () => void loadTree() },
              { k: "col", I: allCollapsed ? ChevronsUpDown : ChevronsDownUp, t: allCollapsed ? "Expand Folders" : "Collapse Folders", on: () => setCollapsed(allCollapsed ? new Set() : new Set(dirs)) },
            ] as const).map(({ k, I, t, on }) => (
              <button key={k} onClick={on} title={t} aria-label={t} {...hp(`tb:${k}`)}
                style={{ appearance: "none", cursor: "pointer", border: 0, background: hov === `tb:${k}` ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: hov === `tb:${k}` ? "var(--txb)" : "var(--txm)", display: "flex", alignItems: "center", padding: 4 }}>
                <I size={13} strokeWidth={1.7} />
              </button>
            ))}
          </div>
          {edit && (
            <div style={{ padding: "0 8px 8px", flex: "none" }}>
              <div style={{ fontSize: "var(--t8)", letterSpacing: 1.2, color: "var(--txl)", marginBottom: 4 }}>
                {edit.mode === "rename" ? "RENAME" : edit.mode === "newdir" ? "NEW FOLDER" : "NEW FILE"}
              </div>
              <input autoFocus value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") submitEdit(); else if (e.key === "Escape") { e.stopPropagation(); setEdit(null); } }}
                onBlur={() => setEdit(null)} placeholder="path/name"
                style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", padding: "5px 7px" }} />
            </div>
          )}
          <div className="mscroll" onContextMenu={(e) => onRowCtx(e, "", true)} {...dragTargetProps("")}
            style={{ flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 8, outline: dropDir === "" ? "1px dashed color-mix(in srgb, var(--acc) 45%, transparent)" : "none", outlineOffset: -2 }}>
            {rows.length === 0 && (
              <div style={{ fontSize: "var(--t11)", color: "var(--txl)", padding: "8px 10px" }}>No files on ⎇ {branch || "this branch"}.</div>
            )}
            {/* vskip-row: the tree is thousands of rows once expanded, and rows
                hover in CSS (.trow) — tracking the hovered one in state re-rendered
                all of them on every mouse move. */}
            <div className="vskip-row">
            {rows.map((r) => r.dir ? (
              <button key={r.key} className="trow" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(r.path)) n.delete(r.path); else n.add(r.path); return n; })}
                onContextMenu={(e) => onRowCtx(e, r.path, true)} title={r.path}
                {...dragSourceProps(r.path)} {...dragTargetProps(r.path)}
                style={{ width: "100%", appearance: "none", border: 0, background: dropDir === r.path ? "color-mix(in srgb, var(--acc) 16%, transparent)" : undefined, opacity: drag === r.path ? 0.45 : 1, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
                <span style={{ fontSize: "var(--t8)", color: "var(--txd)", width: 9, flex: "none", textAlign: "center" }}>{collapsed.has(r.path) ? "▸" : "▾"}</span>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#7fa8a0" strokeWidth="1.7" style={{ flex: "none" }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                <span style={{ fontSize: "var(--t11)", color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.name}</span>
              </button>
            ) : (
              <button key={r.key} className="trow" onClick={() => peekTab(r.path)} onDoubleClick={() => openTab(r.path)}
                ref={r.path === open ? rowRef : undefined}
                onContextMenu={(e) => onRowCtx(e, r.path, false)} title={r.path}
                {...dragSourceProps(r.path)} {...dragTargetProps(parentOf(r.path))}
                style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${r.path === open ? "var(--acc)" : "transparent"}`, background: r.path === open ? "color-mix(in srgb, var(--acc) 8%, transparent)" : undefined, opacity: drag === r.path ? 0.45 : 1, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
                <FileIcon name={r.name} />
                <span style={{ fontSize: "var(--t11)", color: r.path === open ? "var(--txb)" : "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{r.name}</span>
                {r.path === open && dirty && <span style={{ fontSize: "var(--t12)", color: "var(--warn)", flex: "none", lineHeight: 1 }}>●</span>}
              </button>
            ))}
            </div>
          </div>
          </>
          )}
        </div>
        )}

        {/* buffer + chrome */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "color-mix(in srgb, var(--panel3) 50%, transparent)" }}>
          {/* tab strip — click to focus, ✕ or middle-click to close. The dot marks
              unsaved edits, which survive switching away and back. */}
          {tabs.length > 0 && (
            <div className="mscroll" style={{ flex: "none", display: "flex", alignItems: "stretch", overflowX: "auto", borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", background: "color-mix(in srgb, var(--panel2) 40%, transparent)" }}>
              {tabs.map((p, ti) => {
                const on = p === open;
                const mod = isDirty(p);
                const name = labels[ti];
                return (
                  <div key={p} title={p} {...hp(`tab:${p}`)} onDoubleClick={() => openTab(p)}
                    onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(p); } }}
                    style={{ display: "flex", alignItems: "center", gap: 6, flex: "none", maxWidth: 190, padding: "5px 8px 5px 10px", cursor: "pointer", borderRight: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", borderTop: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--panel3) 70%, transparent)" : hov === `tab:${p}` ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent" }}>
                    <span onClick={() => setOpen(p)} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <FileIcon name={name} size={13} />
                      {/* italic = the preview tab, the one the next single click replaces */}
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", fontStyle: p === peek ? "italic" : "normal", color: on ? "var(--txb)" : "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                    </span>
                    <button onClick={() => closeTab(p)} title="close" {...hp(`tabx:${p}`)}
                      style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", flex: "none", lineHeight: 1, padding: "1px 2px", fontFamily: "'JetBrains Mono',monospace", fontSize: mod ? "var(--t12)" : "var(--t10)", color: mod ? "var(--warn)" : hov === `tabx:${p}` ? "var(--txb)" : "var(--txd)" }}>
                      {mod && hov !== `tabx:${p}` ? "●" : "✕"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
            {editable ? (
              <>
                {/* hidden, not unmounted, while previewing — CodeMirror keeps the buffer (and its unsaved edits) */}
                <div ref={hostRef} className="mscroll" style={{ position: "absolute", inset: 0, overflow: "auto", visibility: preview === null ? "visible" : "hidden" }} />
                {preview !== null && (
                  <div className="mscroll" style={{ position: "absolute", inset: 0, overflow: "auto", padding: "14px 18px", fontSize: "var(--t125)", lineHeight: 1.65, color: "var(--tx)" }}>
                    <Markdown>{preview}</Markdown>
                  </div>
                )}
              </>
            ) : meta?.image ? (
              <div className="mscroll" style={{ position: "absolute", inset: 0, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
                <img src={meta.image} alt={open ?? ""} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
              </div>
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", color: "var(--txd)" }}>
                {!open ? "Select a file to edit."
                  : !meta ? "Loading…"
                  : !meta.ok ? (meta.error || "Can't open this file.")
                  : meta.binary ? "Binary file — not editable here."
                  : meta.too_large ? "File is over 1 MB — too large to edit here."
                  : ""}
              </div>
            )}
          </div>
          <div style={{ flex: "none", display: "flex", alignItems: "stretch", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)" }}>
            <span style={{ background: dirty ? "var(--warn)" : "var(--acc)", color: "var(--acc-on)", fontWeight: 700, letterSpacing: 1.5, padding: "5px 12px", flex: "none" }}>{saving ? "SAVING" : dirty ? "UNSAVED" : preview !== null ? "VIEW" : "EDIT"}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 12px", color: "var(--txm)", flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--acc) 5%, transparent)" }}>
              <span style={{ color: "var(--purple)", flex: "none" }}>⎇ {branch || "—"}</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{open || "no file"}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", padding: "5px 12px", color: note ? "#a7e6c3" : "var(--txd)", flex: "none", background: "color-mix(in srgb, var(--acc) 5%, transparent)", whiteSpace: "nowrap" }}>
              {statusRight}
            </span>
          </div>
          <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", padding: "6px 10px", fontFamily: "'JetBrains Mono',monospace" }}>
            <button onClick={() => void save()} disabled={!editable || saving || !dirty} title="save (Ctrl-S / :w)" {...hp("save")}
              style={{ appearance: "none", cursor: editable && dirty && !saving ? "pointer" : "not-allowed", border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", background: hov === "save" && editable && dirty ? "color-mix(in srgb, var(--ok) 14%, transparent)" : "transparent", color: "var(--ok)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 10px", opacity: editable && dirty && !saving ? 1 : 0.45 }}>▸ SAVE</button>
            {editable && (
              <button onClick={() => void format()} disabled={fmting || meta?.formatter === false}
                title={meta?.formatter === false ? "no formatter installed for this file type" : "format (Shift-Alt-F)"} {...hp("fmt")}
                style={{ appearance: "none", cursor: fmting || meta?.formatter === false ? "not-allowed" : "pointer", border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", background: hov === "fmt" && !fmting && meta?.formatter !== false ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent", color: "var(--purple)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 10px", opacity: fmting || meta?.formatter === false ? 0.45 : 1 }}>
                {fmting ? "⋯ FORMATTING" : "⌘ FORMAT"}</button>
            )}
            {editable && isMd && (
              <button onClick={() => setPreview((p) => (p === null ? viewRef.current?.state.doc.toString() ?? meta?.content ?? "" : null))}
                title={preview === null ? "preview rendered markdown" : "back to the editor"} {...hp("mdv")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: hov === "mdv" || preview !== null ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "transparent", color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 10px" }}>
                {preview === null ? "◧ VIEW" : "✎ EDIT"}</button>
            )}
            <span style={{ color: "var(--acc)", flex: "none" }}>:</span>
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={onCmdKey}
              placeholder="w · wq · fmt"
              style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)" }} />
          </div>
        </div>

        {/* quick-open palette — files · @symbols · >commands */}
        {palQ !== null && (
          <>
            <div onClick={() => setPalQ(null)} style={{ position: "absolute", inset: 0, zIndex: 40, background: "color-mix(in srgb, var(--panel3) 55%, transparent)" }} />
            <div style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 41, width: "min(520px, 92%)", border: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 16px 44px var(--shadow-pop)", animation: "mslide .16s ease both" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
                <span style={{ color: "var(--acc)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)", flex: "none" }}>
                  {palMode === "@" ? "@" : palMode === ">" ? ">" : "⌕"}
                </span>
                <input autoFocus value={palQ} onChange={(e) => setPalQ(e.target.value)} onKeyDown={onPalKey}
                  placeholder="file name · @symbol in this file · >command"
                  style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)" }} />
                <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txl)", flex: "none" }}>{palRows.length}</span>
              </div>
              <div className="mscroll" style={{ maxHeight: 300, overflowY: "auto" }}>
                {palRows.length === 0 && (
                  <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "10px 12px", fontFamily: "'JetBrains Mono',monospace" }}>
                    {palMode === "@" && !open ? "Open a file first — @ lists its functions." : "No matches."}
                  </div>
                )}
                {palRows.map((it, i) => (
                  <button key={`${it.path}:${it.line ?? 0}:${i}:${it.label}`} onClick={() => runPal(it)}
                    onMouseEnter={() => setPalIdx(i)}
                    style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${i === palIdx ? "var(--acc)" : "transparent"}`, background: i === palIdx ? "color-mix(in srgb, var(--acc) 9%, transparent)" : "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "baseline", gap: 8, padding: "5px 10px" }}>
                    <span style={{ fontSize: "var(--t11)", color: i === palIdx ? "var(--txb)" : "var(--txh)", flex: "none", maxWidth: "60%", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
                    {/* a command's `sub` is its key: right-aligned like VS Code, and
                        never reversed the way a path is */}
                    <span style={{ fontSize: "var(--t95)", color: "var(--txl)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: it.run ? "ltr" : "rtl", textAlign: it.run ? "right" : "left" }}>{it.sub}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      {ctx && (
        <ContextMenu ctx={{ x: ctx.x, y: ctx.y, type: ctx.dir ? "folder" : "file", id: ctx.path, label: ctx.path || "repo root" }}
          items={ctxItems(ctx)} onClose={() => setCtx(null)} />
      )}
    </div>
  );
}
