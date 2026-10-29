import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import {
  AlignLeft, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, FilePlus, Files, FolderPlus, GitCompare,
  ListTree, Pencil, RefreshCw, Save, Search, Waypoints,
} from "lucide-react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { Vim, vim } from "@replit/codemirror-vim";
import { api, type FileContent, type GitFile, type GrepHit } from "../../api";
import { Markdown } from "../Markdown";
import { ImageLightbox } from "../ImageLightbox";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { chord } from "../../lib/chord";
import { cmpTreePath } from "../../lib/pathsort";
import { nextFocus, previewTabs, remapPaths, tabLabels, underPath } from "../../lib/tabs";
import { langFor } from "../../lib/langfor";
import { FileIcon } from "../../lib/fileicon";
import { ignoredMatcher } from "../../lib/gitignored";
import { symbolsIn, type Symbol } from "../../lib/symbols";
import { byFile, defSpan, importSource, NAV0, navBack, navFwd, navPush, rankDefs, signature, type Hit, type Loc, type Nav } from "../../lib/trace";
import { codeLines, modClick, overviewRuler, peekDom, peekField, peekOpen, setPeek as peekAt, stickyScroll, symbolHover, type HoverInfo } from "./editorext";
import { ChangesView, kindOf, OutlineView, RefsView } from "./EditorSide";
import { clampFont, loadPrefs, savePrefs, type EditorPrefs } from "../../lib/editorprefs";
import { askConfirm } from "../ui/Ask";
import { registerEditor } from "../../lib/editorctx";

/* EDITOR tab — a real file editor (not the diff viewer it used to be). Browses
   the whole working tree of the selected branch/worktree, opens any file into an
   editable CodeMirror 6 buffer with syntax highlighting, and saves to disk via
   Ctrl-S / :w (POST /local/files/write). Files the browser can display itself —
   images, PDFs, video, audio — open in a viewer instead (see MediaView); other
   binary and oversized files load read-only with a placeholder.

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
  initialFile?: string; // opened straight away (sidebar FILES → editor modal)
  initialLine?: number;  // ...scrolled to this line (a chat `file.ts:42` link)
  /** How the window opened: "changes" lands on CHANGES with the file's diff inline, "map" on the map. */
  initialMode?: "changes" | "editor" | "terminal" | "map";
  /** The window's title bar reaches in here: its ⌘P box opens this palette. */
  bus?: { current: { palette?: () => void } };
  /** What this session wrote (lib/sessionedits), relative to the tree — ✦ in CHANGES. */
  edited?: Set<string>;
  /** ✦ Ask Claude / REVIEW: `text` for the prompt; `close` = no unsaved edits, the window may go. */
  onAsk?: (text: string, close: boolean) => void;
  /** COMMIT IN GIT ›: the rail's GIT tab commits and pushes. */
  onOpenGit?: () => void;
  /** The project map, shown in place of the code while its activity icon is on. */
  mapView?: ReactNode;
  /** The terminal drawer (TermDrawer), under the code. */
  drawer?: ReactNode;
  onToggleTerm?: () => void;
}

type SideView = "explorer" | "search" | "outline" | "changes" | "refs";

/* Where the cursor is, for the status bar, the breadcrumbs and OUTLINE: a tiny
   store the CodeMirror update listener writes, so a cursor move re-renders
   those three and not the whole tab (the explorer can be thousands of rows). */
interface Cur {
  line: number; col: number;
  syms: Symbol[];      // the file's outline
  chain: Symbol[];     // the definitions around the cursor, outermost first
  word: string; uses: number;   // the name under the cursor, how often it's in the file
  chunk: { i: number; n: number } | null;   // which of the diff's changes the cursor is at
}
const CUR0: Cur = { line: 1, col: 1, syms: [], chain: [], word: "", uses: 0, chunk: null };
function makeStore<T>(v: T) {
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(n: T) { v = n; subs.forEach((f) => f()); },
    sub(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}
type CurStore = ReturnType<typeof makeStore<Cur>>;

const IDENT = /^[A-Za-z_$][\w$]*$/;
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

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
  show?: string;  // a binding the key handler matches itself, shown like `key`
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
const vimComp = new Compartment();
// The diff against HEAD: unifiedMergeView, inline or gutter-only (CHANGES).
const diffComp = new Compartment();
const diffExt = (base: string | null | undefined, mode?: "inline" | "gutter") =>
  base == null || !mode ? [] : [
    // The default scanLimit (500 changed chars) turns any real rewrite into one
    // red block over the whole file; a time budget bounds the cost instead.
    unifiedMergeView({ original: base, mergeControls: false, gutter: true, highlightChanges: mode === "inline", syntaxHighlightDeletions: true,
      diffConfig: { scanLimit: 1e7, timeout: 400 } }),
    mode === "gutter" ? EditorView.editorAttributes.of({ class: "cm-diff-gutter" }) : [],
  ];
const wrapExt = (on: boolean) => (on ? EditorView.lineWrapping : []);
const fontExt = (px: number) => EditorView.theme({ "&": { fontSize: `${px}px` } });

/* `:w` and `:fmt` route through the editor's own save/format so .editorconfig
   cleanup and the bridge formatter still run. Registered against refs, so they
   always hit the current file. */
const vimSaveRef = { current: () => {} };
const vimFmtRef = { current: () => {} };
Vim.defineEx("write", "w", () => vimSaveRef.current());
Vim.defineEx("fmt", "fmt", () => vimFmtRef.current());

/* Anything the browser renders itself — image, PDF, video, audio — shown in
   place of the buffer. Chrome and Safari both refuse to paint a `data:` PDF in
   an iframe, so PDFs get a blob URL; the rest read the data URL directly. */
function MediaView({ src, mime, name }: { src: string; mime: string; name: string }) {
  const pdf = mime === "application/pdf";
  const [blob, setBlob] = useState("");
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!pdf) return;
    const bytes = Uint8Array.from(atob(src.slice(src.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setBlob(url);
    return () => URL.revokeObjectURL(url);
  }, [src, mime, pdf]);

  const box: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: pdf ? 0 : 18 };
  if (pdf) {
    return (
      <div style={box}>
        {/* iOS WebViews ignore iframed PDFs entirely — the link below is the way
            out on a phone, so it isn't only a convenience. */}
        {blob && <iframe src={blob} title={name} style={{ width: "100%", height: "100%", border: 0, background: "var(--panel3)" }} />}
        <a href={blob || src} download={name.split("/").pop()} target="_blank" rel="noreferrer"
          style={{ position: "absolute", right: 12, bottom: 12, fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", letterSpacing: 1, padding: "4px 10px", color: "var(--acc)", background: "color-mix(in srgb, var(--panel2) 92%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", textDecoration: "none" }}>
          ↓ OPEN
        </a>
      </div>
    );
  }
  if (mime.startsWith("video/")) return <div style={box}><video src={src} controls style={{ maxWidth: "100%", maxHeight: "100%" }} /></div>;
  if (mime.startsWith("audio/")) return <div style={box}><audio src={src} controls style={{ width: "min(420px, 100%)" }} /></div>;
  // The pane fits the image to the pane; the lightbox is where it can be read
  // at size, so the image opens into it rather than growing a viewer of its own.
  return (
    <div className="mscroll" style={{ ...box, overflow: "auto" }}>
      {zoom && <ImageLightbox src={src} onClose={() => setZoom(false)} />}
      <img
        src={src}
        alt={name}
        role="button"
        tabIndex={0}
        onClick={() => setZoom(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setZoom(true); }}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", cursor: "zoom-in" }}
      />
    </div>
  );
}

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
  // The word under the cursor and its other uses (highlightSelectionMatches).
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--acc) 17%, transparent)", borderRadius: "2px" },
  ".cm-selectionMatch-main": { backgroundColor: "color-mix(in srgb, var(--acc) 26%, transparent)" },
  // ⌘/Ctrl-hover: the name you'd jump to (editorext modClick).
  ".cm-modlink, .cm-modlink *": { color: "var(--acc) !important", textDecoration: "underline", textUnderlineOffset: "3px", cursor: "pointer" },
  // Sticky scroll: the definitions you're inside, pinned over the top lines.
  ".cm-sticky": {
    position: "absolute", top: 0, left: 0, right: "10px", zIndex: 5, overflow: "hidden",
    background: "linear-gradient(color-mix(in srgb, var(--panel3) 50%, transparent), color-mix(in srgb, var(--panel3) 50%, transparent)), var(--panel2)",
    borderBottom: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", boxShadow: "0 8px 14px -10px rgba(0,0,0,.6)",
  },
  ".cm-sticky-line": { display: "flex", lineHeight: "1.6", cursor: "pointer", whiteSpace: "pre", fontFamily: "'JetBrains Mono',monospace" },
  ".cm-sticky-line:hover": { background: "color-mix(in srgb, var(--acc) 6%, transparent)" },
  ".cm-sticky-num": { flex: "none", textAlign: "right", paddingRight: "17px", boxSizing: "border-box", color: "var(--txg)" },
  ".cm-sticky-code": { paddingLeft: "6px", color: "var(--txh)" },
  // Overview ruler: the word's uses, the diff, the cursor, down the right edge.
  ".cm-ruler": { position: "absolute", top: 0, right: 0, bottom: 0, width: "10px", zIndex: 4, pointerEvents: "none", borderLeft: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)" },
  ".cm-ruler i": { position: "absolute", left: "2px", right: "2px", height: "3px", minHeight: "3px", borderRadius: "1px" },
  ".cm-ruler i[data-k=w]": { background: "color-mix(in srgb, var(--acc) 75%, transparent)" },
  ".cm-ruler i[data-k=add]": { background: "var(--ok)" },
  ".cm-ruler i[data-k=mod]": { background: "var(--warn)" },
  ".cm-ruler i[data-k=del]": { background: "var(--err)" },
  ".cm-ruler i[data-k=cur]": { left: 0, right: 0, height: "2px", minHeight: "2px", background: "var(--txb)" },
  // Peek (⌥F12): another place's code, inline under the line.
  ".cm-peek": {
    margin: "2px 0", borderTop: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)",
    background: "color-mix(in srgb, var(--panel2) 92%, transparent)", fontFamily: "'JetBrains Mono',monospace",
  },
  ".cm-peek-head": {
    display: "flex", alignItems: "center", gap: "8px", height: "26px", padding: "0 10px", background: "color-mix(in srgb, var(--acc) 11%, transparent)",
    fontFamily: "var(--ui-font, inherit)", fontSize: "var(--t10)", color: "var(--txl)", whiteSpace: "nowrap",
  },
  ".cm-peek-head b": { color: "var(--txb)", fontWeight: 500 },
  ".cm-peek-head em": { fontStyle: "normal", fontSize: "var(--t75)", letterSpacing: "1px", color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)", padding: "0 4px", lineHeight: "14px" },
  ".cm-peek-head button": { appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t10)", padding: "0 4px" },
  ".cm-peek-head button:hover": { color: "var(--txb)" },
  ".cm-peek .cm-codelines": { padding: "3px 0 4px" },
  ".cm-codeline": { display: "flex", whiteSpace: "pre", lineHeight: "1.6" },
  ".cm-codeline-on": { background: "color-mix(in srgb, var(--acc) 8%, transparent)" },
  ".cm-codenum": { flex: "none", width: "46px", textAlign: "right", paddingRight: "14px", color: "var(--txg)" },
  ".cm-codetext": { color: "var(--txh)" },
  // Hover: a definition's signature, its comment, where it lives.
  ".cm-tooltip.cm-tooltip-hover": { maxWidth: "min(560px, 80vw)" },
  ".cm-symhover-sig": { padding: "8px 11px 6px", fontFamily: "'JetBrains Mono',monospace" },
  ".cm-symhover-sig .cm-codenum": { display: "none" },
  ".cm-symhover-sig .cm-codeline": { whiteSpace: "pre-wrap" },
  ".cm-symhover-doc": { padding: "0 11px 9px", fontFamily: "var(--ui-font, inherit)", fontSize: "var(--t11)", lineHeight: 1.5, color: "var(--txm)" },
  ".cm-symhover-foot": { padding: "6px 11px", borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", fontFamily: "var(--ui-font, inherit)", fontSize: "var(--t85)", color: "var(--txl)", whiteSpace: "pre" },
  // The diff against HEAD (@codemirror/merge): green added, red removed, and a
  // gutter bar each. `cm-diff-gutter` keeps only the bars.
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "color-mix(in srgb, var(--ok) 9%, transparent)" },
  "&.cm-merge-b .cm-changedText": { background: "color-mix(in srgb, var(--ok) 24%, transparent)" },
  ".cm-deletedChunk": { backgroundColor: "color-mix(in srgb, var(--err) 10%, transparent)", paddingLeft: "6px" },
  "& .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": { background: "color-mix(in srgb, var(--err) 24%, transparent)" },
  ".cm-changeGutter": { width: "3px", paddingLeft: 0 },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--ok)" },
  "& .cm-deletedLineGutter": { background: "var(--err)" },
  "&.cm-diff-gutter .cm-deletedChunk": { display: "none" },
  "&.cm-diff-gutter .cm-changedLine": { backgroundColor: "transparent" },
}, { dark: true });

/* The modal unmounts this tab on every switch, and walking a repo again costs
   ~130ms of empty explorer. The last tree per project+branch paints straight
   away; the fresh walk still runs and replaces it.
   ponytail: unbounded — one file list per project+branch opened this session. */
const treeCache = new Map<string, { files: string[]; ignored: string[] }>();
const treeKey = (project: string, branch: string) => `${project}\n${branch}`;

export function EditorTab({ project, branch, initialFile, initialLine, initialMode, bus, edited, onAsk, onOpenGit, mapView, drawer, onToggleTerm }: Props) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [paths, setPaths] = useState<string[]>([]);
  // .gitignore'd paths, as prefixes — listed like everything else, just dimmed.
  const [ignored, setIgnored] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<string[]>([]);             // open buffers, left to right
  const [peek, setPeek] = useState<string | null>(null);      // the preview tab, if any (see peekTab)
  const [open, setOpen] = useState<string | null>(null);      // path being edited
  const [meta, setMeta] = useState<FileContent | null>(null); // load result (binary/too_large flags)
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fmting, setFmting] = useState(false);
  const [lang, setLang] = useState("");   // detected language, shown in the status bar
  const [note, setNote] = useState("");
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
  const [view, setView] = useState<SideView>(initialMode === "changes" ? "changes" : "explorer");
  const [sideOpen, setSideOpen] = useState(true);
  const [sideW, setSideW] = useState(248);   // dragged on the border, see the handle below
  const [searchQ, setSearchQ] = useState("");
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [grepBusy, setGrepBusy] = useState(false);
  // explorer file management: right-click menu + the new/rename input bar
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);      // row being dragged
  const [dropDir, setDropDir] = useState<string | null>(null); // folder under the cursor
  const [edit, setEdit] = useState<{ mode: "new" | "newdir" | "rename"; path: string; value: string } | null>(null);
  // Tracing: back/forward, the REFERENCES list, the map in place of the code.
  const [nav, setNav] = useState<Nav>(NAV0);
  const [refs, setRefs] = useState<{ title: "References" | "Definitions"; word: string; busy: boolean; hits: Hit[]; defs: Set<string>; here: string } | null>(null);
  const [mapOpen, setMapOpen] = useState(initialMode === "map");
  // CHANGES: the branch's uncommitted files, each one's text at HEAD (null:
  // couldn't read it) and how its diff shows.
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitBusy, setGitBusy] = useState(false);
  const [heads, setHeads] = useState<Record<string, string | null>>({});
  const [diffs, setDiffs] = useState<Record<string, "inline" | "gutter">>(
    initialMode === "changes" && initialFile ? { [initialFile]: "inline" } : {});
  const firstChunk = useRef(initialMode === "changes" ? initialFile ?? "" : "");   // land on its first change once the diff is on
  const [curStore] = useState(() => makeStore(CUR0));
  const lastDoc = useRef<EditorState["doc"] | null>(null);

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

  // Where the cursor is → the status bar, the breadcrumbs and OUTLINE (Cur).
  function publish(st: EditorState | null) {
    if (!st) { curStore.set(CUR0); return; }
    const head = st.selection.main.head, ln = st.doc.lineAt(head);
    const syms = symbolsIn(st, 100);
    const chain = syms.filter((x) => x.from <= head && head <= x.to);
    const w = st.selection.main.empty ? st.wordAt(head) : null;
    const word = w && w.to - w.from > 1 && IDENT.test(st.sliceDoc(w.from, w.to)) ? st.sliceDoc(w.from, w.to) : "";
    const prev = curStore.get();
    let uses = 0;
    if (word && word === prev.word && st.doc === lastDoc.current) uses = prev.uses;
    else if (word && st.doc.length < 2_000_000) uses = st.doc.toString().match(new RegExp(`(?<![\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`, "g"))?.length ?? 0;
    lastDoc.current = st.doc;
    const ch = getChunks(st)?.chunks;
    const chunk = ch && ch.length ? { i: Math.max(1, ch.filter((c) => c.fromB <= head).length), n: ch.length } : null;
    if (prev.line === ln.number && prev.col === head - ln.from + 1 && prev.syms === syms && prev.word === word && prev.uses === uses
        && prev.chain.length === chain.length && prev.chain.every((c, i) => c === chain[i]) && prev.chunk?.i === chunk?.i && prev.chunk?.n === chunk?.n) return;
    curStore.set({ line: ln.number, col: head - ln.from + 1, syms, chain, word, uses, chunk });
  }

  function flash(m: string) {
    setNote(m);
    if (noteT.current) clearTimeout(noteT.current);
    noteT.current = setTimeout(() => setNote(""), 3000);
  }
  useEffect(() => () => { if (noteT.current) clearTimeout(noteT.current); }, []);

  const loadTree = () =>
    api.filesTree(project, branch || undefined)
      .then((r) => {
        treeCache.set(treeKey(project, branch), { files: r.files, ignored: r.ignored ?? [] });
        setPaths(r.files); setIgnored(r.ignored ?? []);
      })
      .catch(() => { setPaths([]); setIgnored([]); });

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
    jumpRef.current = initialLine ?? 0;
    // Closed by default — a repo tree fully expanded is thousands of rows to
    // scroll past before reaching anything.
    const shut = (files: string[]) =>
      new Set(dirsOf(files).filter((d) => !initialFile || !underPath(d, initialFile)));
    const seed = treeCache.get(treeKey(project, branch));
    if (seed) { setPaths(seed.files); setIgnored(seed.ignored); setCollapsed(shut(seed.files)); }
    void api.filesTree(project, branch || undefined)
      .then((r) => {
        if (!live) return;
        treeCache.set(treeKey(project, branch), { files: r.files, ignored: r.ignored ?? [] });
        setPaths(r.files);
        setIgnored(r.ignored ?? []);
        if (!seed) setCollapsed(shut(r.files));   // a seeded tree keeps folders you opened
      })
      .catch(() => { if (live) { setPaths([]); setIgnored([]); } });
    return () => { live = false; };
  }, [project, branch, initialFile, initialLine]);

  const isIgnored = useMemo(() => ignoredMatcher(ignored), [ignored]);
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
  // SVG stays an editable text buffer (it is markup), but shares markdown's
  // VIEW toggle so you can see what you just edited.
  const isSvg = !!open && /\.svg$/i.test(open);
  const canPreview = isMd || isSvg;

  // (Re)build the CodeMirror view when an editable file's contents arrive.
  useEffect(() => {
    // A file switch renders once with the last file's result still in `meta`;
    // building a view from it showed the old text under the new tab and spent
    // the pending jump (a definition or search hit landed on line 1).
    const norm = (p: string) => p.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");
    const mine = !!meta && (!meta.path || !open || norm(meta.path) === norm(open));
    if (!hostRef.current || !editable || !open || !meta || !mine) {
      if (meta && mine && !editable) jumpRef.current = 0;   // binary/too large: no line to jump to
      publish(null);
      return;
    }
    const fresh = EditorState.create({
      doc: bufs.current.get(open)?.text ?? meta.content ?? "",
      extensions: [
        // Above even the Ctrl-S binding: vim owns Escape and every bare key while
        // it's on, and a keymap below it would swallow operator-pending input.
        vimComp.of(prefs.vim ? vim() : []),
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
        wrapComp.of(wrapExt(prefs.wordWrap)),
        fontComp.of(fontExt(prefs.fontSize)),
        langComp.of([]),   // filled in below, once the language chunk lands
        // Reading + tracing (editorext): the word under the cursor lit, the
        // enclosing definitions pinned on top, marks down the right edge, the
        // ⌥F12 peek, hover cards, ⌘-click — and the diff against HEAD.
        highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 2 }),
        peekField,
        stickyScroll(crtHighlight, (n) => { if (viewRef.current) gotoLine(viewRef.current, n); }),
        overviewRuler(),
        symbolHover((w, pos, v) => hoverRef.current(w, pos, v)),
        modClick((pos) => void goDefRef.current(pos)),
        diffComp.of([]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            setDirty(u.state.doc.toString() !== baseRef.current);
            setPeek((p) => (p === open ? null : p));   // editing a preview keeps it, VS Code-style
          }
          if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.reconfigured)) publish(u.state);
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
    // The right-click menu's rows (lib/editorctx). This effect rebuilds the view
    // whenever open/meta change, so capturing them here never goes stale; Format
    // goes through fmtRef like Shift-Alt-F does.
    const unregister = registerEditor("editor", {
      view,
      path: () => open,
      actions: {
        ...(meta.formatter === false ? {} : { format: () => fmtRef.current() }),
        symbol: () => setPalQ("@"),
        find: () => showView("search"),
        def: () => void goDefRef.current(),
        peek: () => void peekRef.current(),
        refs: () => void refsRef.current(),
      },
      leaveOk: () => leaveOk.current(),
    });
    view.focus();
    // A restored tab carries the compartments from its last mount, so a pref
    // toggled while another tab was focused never reached it. Re-sync on mount —
    // same reason langComp is dispatched here rather than baked into `fresh`.
    view.dispatch({ effects: [
      wrapComp.reconfigure(wrapExt(prefs.wordWrap)),
      fontComp.reconfigure(fontExt(prefs.fontSize)),
      vimComp.reconfigure(prefs.vim ? vim() : []),
    ] });
    publish(view.state);
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
      unregister();
      view.destroy(); viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, open, meta]);

  // Prefs change far more often than files do — reconfigure in place rather than
  // rebuilding the buffer, which would drop the cursor.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: [
      wrapComp.reconfigure(wrapExt(prefs.wordWrap)),
      fontComp.reconfigure(fontExt(prefs.fontSize)),
      vimComp.reconfigure(prefs.vim ? vim() : []),
    ] });
  }, [prefs.wordWrap, prefs.fontSize, prefs.vim]);

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
    // Claim the guard before the first await, not after: `format()` is a round
    // trip to the bridge, and a second Ctrl-S during it would sail past a guard
    // that hasn't been set yet, no-op inside format()'s own `fmting` guard, then
    // write the *unformatted* buffer in a race with this call's write.
    setSaving(true);
    // Format first when asked — format() swaps the buffer, and the read below
    // picks the result up. A formatter failure only flashes; the save still runs.
    if (prefs.formatOnSave && meta?.formatter !== false) await format();
    const raw = v.state.doc.toString();
    const content = tidy(raw);
    if (content !== raw) replaceDoc(v, content);   // keep the buffer equal to disk
    try {
      const r = await api.fileWrite(project, open, content, branch || undefined);
      if (r.ok) {
        baseRef.current = content;
        const b = bufs.current.get(open);
        if (b) { b.text = content; b.base = content; b.state = v.state; }
        setDirty(false); flash(`wrote ${open}`);
        dropCaches(); loadGit();
      }
      else flash(`E212: ${r.error || "write failed"}`);
    } catch (e) {
      flash(`E212: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = () => { void save(); };
  vimSaveRef.current = () => { void save(); };
  vimFmtRef.current = () => { void format(); };

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

  /* ---- tracing: definition, peek, references, back/forward (lib/trace) ---- */

  // Other files' text and the bridge's greps, per word, until a save or a
  // branch switch makes them stale.
  const cache = useRef({ text: new Map<string, Promise<string | null>>(), def: new Map<string, Promise<Hit[]>>(), word: new Map<string, Promise<Hit[]>>() });
  const dropCaches = () => { cache.current = { text: new Map(), def: new Map(), word: new Map() }; };
  useEffect(dropCaches, [project, branch]);
  const textOf = (p: string) => {
    let t = cache.current.text.get(p);
    if (!t) {
      t = api.fileRead(project, p, branch || undefined)
        .then((r) => (r.ok && !r.binary && !r.too_large ? r.content ?? "" : null)).catch(() => null);
      cache.current.text.set(p, t);
    }
    return t;
  };
  const grepOf = (mode: "def" | "word", w: string) => {
    let h = cache.current[mode].get(w);
    if (!h) {
      // Prose mentions (a plan's code fence, a README) aren't definitions or uses.
      h = api.filesGrep(project, w, branch || undefined, mode)
        .then((r) => r.hits.filter((x) => !/\.(md|mdx|markdown|txt|rst)$/i.test(x.path))).catch(() => [] as Hit[]);
      cache.current[mode].set(w, h);
    }
    return h;
  };

  const here = (): Loc | null => {
    const v = viewRef.current;
    if (!open) return null;
    return { path: open, line: v ? v.state.doc.lineAt(v.state.selection.main.head).number : 1 };
  };
  /** Go to a place, remembering where you were for ‹ (unless `push` is false). */
  function jump(to: Loc, push = true) {
    const from = here();
    if (push && from) setNav((n) => navPush(n, from));
    setMapOpen(false);
    openFile(to.path, to.line);
  }
  function goBack() {
    const h = here();
    const [n, to] = h ? navBack(nav, h) : [nav, null];
    if (to) { setNav(n); setMapOpen(false); openFile(to.path, to.line); }
  }
  function goFwd() {
    const h = here();
    const [n, to] = h ? navFwd(nav, h) : [nav, null];
    if (to) { setNav(n); setMapOpen(false); openFile(to.path, to.line); }
  }

  const wordUnder = (v: EditorView, pos: number) => {
    const w = v.state.wordAt(pos), s = w ? v.state.sliceDoc(w.from, w.to) : "";
    return IDENT.test(s) ? s : null;
  };

  /** Where `word` (at `pos` in the open file) is defined, best first. `sure`:
   *  the open file's own definition, an import we resolved, or a lone hit —
   *  what a hover may show without guessing. */
  async function locate(word: string, pos: number): Promise<{ hits: Hit[]; sure: boolean }> {
    const v = viewRef.current;
    if (!v || !open) return { hits: [], sure: false };
    // A short parse budget: hover asks too, and a half-parsed giant file still
    // answers through the grep below.
    const mine = symbolsIn(v.state, 200).filter((x) => x.name === word);
    if (mine.length) {
      const best = [...mine].reverse().find((x) => x.from <= pos) ?? mine[0];
      return { hits: [{ path: open, line: best.line, text: v.state.doc.line(best.line).text.trim() }], sure: true };
    }
    const source = importSource(v.state.doc.toString(), word, open, paths);
    let hits = rankDefs(await grepOf("def", word), open, source);
    if (hits[0]?.path === open) {
      // Several in this file (a `const x` per function): the nearest one above wins.
      const ln = v.state.doc.lineAt(pos).number, own = hits.filter((h) => h.path === open);
      const best = [...own].reverse().find((h) => h.line <= ln) ?? own[0];
      hits = [best, ...hits.filter((h) => h !== best)];
    }
    if (source && !hits.some((h) => h.path === source)) hits = [{ path: source, line: 1, text: "" }, ...hits];
    return { hits, sure: !!source || hits[0]?.path === open || hits.length === 1 };
  }

  async function goDef(pos?: number) {
    const v = viewRef.current;
    if (!v || !open) return;
    const at = pos ?? v.state.selection.main.head, w = wordUnder(v, at);
    if (!w) return;
    const { hits, sure } = await locate(w, at);
    if (!hits.length) { flash(`no definition found for ${w}`); return; }
    if (sure) { jump(hits[0]); return; }
    // Same name in several modules: let the reader pick.
    setRefs({ title: "Definitions", word: w, busy: false, hits, defs: new Set(hits.map((h) => `${h.path}:${h.line}`)), here: "" });
    showView("refs");
  }

  async function peekDef(pos?: number) {
    const v = viewRef.current;
    if (!v || !open) return;
    const at = pos ?? v.state.selection.main.head, w = wordUnder(v, at);
    if (!w) return;
    const top = (await locate(w, at)).hits[0];
    if (!top) { flash(`no definition found for ${w}`); return; }
    let text: string | null, tree = null;
    if (top.path === open) {
      text = v.state.doc.toString();
      tree = ensureSyntaxTree(v.state, v.state.doc.line(Math.min(top.line + 20, v.state.doc.lines)).to, 200) ?? syntaxTree(v.state);
    } else {
      text = await textOf(top.path);
      const sup = text == null ? null : await langFor(top.path)?.load().catch(() => null);
      tree = sup && text != null ? sup.language.parser.parse(text) : null;
    }
    if (text == null) { flash(`can't read ${top.path}`); return; }
    const [a, b] = defSpan(text.split("\n"), top.line);
    const body = codeLines(text, tree, crtHighlight, a, b, top.line);
    const cur = viewRef.current;
    cur?.dispatch({ effects: peekAt.of({
      line: cur.state.doc.lineAt(at).number,
      dom: () => peekDom({
        file: top.path.split("/").pop() ?? top.path, where: `${top.path.split("/").slice(0, -1).join("/") || "."} · line ${top.line}`,
        tag: "DEFINITION", body: body.cloneNode(true) as HTMLElement,
        onOpen: () => { viewRef.current?.dispatch({ effects: peekAt.of(null) }); jump(top); },
        onClose: () => { viewRef.current?.dispatch({ effects: peekAt.of(null) }); viewRef.current?.focus(); },
      }),
    }) });
  }

  async function findRefs(pos?: number) {
    const v = viewRef.current;
    if (!v || !open) return;
    const at = pos ?? v.state.selection.main.head, w = wordUnder(v, at);
    if (!w) return;
    const from = `${open}:${v.state.doc.lineAt(at).number}`;
    setRefs({ title: "References", word: w, busy: true, hits: [], defs: new Set(), here: from });
    showView("refs");
    const [uses, defs] = await Promise.all([grepOf("word", w), grepOf("def", w)]);
    const isDef = new Set(defs.map((d) => `${d.path}:${d.line}`));
    // The definition's file first, then this one, then the rest as git lists them.
    const rank = (h: Hit) => (isDef.has(`${h.path}:${h.line}`) || defs.some((d) => d.path === h.path) ? 0 : h.path === open ? 1 : 2);
    const hits = uses.map((h, i) => [h, i] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([h]) => h);
    setRefs((r) => (r && r.word === w && r.here === from ? { ...r, busy: false, hits, defs: isDef } : r));
  }

  // Ask Claude: the prompt gets `text`; the window closes unless it holds unsaved edits.
  const ask = (text: string) => { if (onAsk) onAsk(text, leaveOk.current()); };
  function askAbout(word: string, hits: Hit[], defs: Set<string>) {
    const def = hits.find((h) => defs.has(`${h.path}:${h.line}`));
    const uses = hits.filter((h) => h !== def);
    ask(`Explain \`${word}\`${def ? ` (${def.path}:${def.line})` : ""} and how the code below depends on it:\n`
      + uses.slice(0, 12).map((h) => `- ${h.path}:${h.line}`).join("\n")
      + (uses.length > 12 ? `\n- …and ${uses.length - 12} more` : ""));
  }

  // The hover card: only what the trace is sure of, never a same-named stranger.
  const hoverRef = useRef<(w: string, pos: number, v: EditorView) => Promise<HoverInfo | null>>(async () => null);
  hoverRef.current = async (word, pos, v) => {
    const { hits, sure } = await locate(word, pos);
    const top = hits[0];
    if (!top || !sure) return null;
    const text = top.path === open ? v.state.doc.toString() : await textOf(top.path);
    const lines = text?.split("\n");
    if (!lines?.[top.line - 1]?.trim()) return null;
    const { sig, doc } = signature(lines, top.line);
    const sup = await langFor(top.path)?.load().catch(() => null);
    const el = codeLines(sig, sup ? sup.language.parser.parse(sig) : null, crtHighlight, 1, 1);
    el.classList.add("cm-symhover-sig");
    return { sig: el, doc, where: `${top.path.split("/").pop()}:${top.line}`, refs: (await grepOf("word", word)).length };
  };
  const goDefRef = useRef<(pos?: number) => Promise<void>>(async () => {});
  goDefRef.current = goDef;
  const peekRef = useRef<() => Promise<void>>(async () => {});
  peekRef.current = () => peekDef();
  const refsRef = useRef<() => Promise<void>>(async () => {});
  refsRef.current = () => findRefs();

  /* ---- CHANGES: the branch's uncommitted files, each one's diff vs HEAD ---- */

  const loadGit = () => {
    setGitBusy(true);
    void api.git(project, branch || undefined)
      // A branch with no worktree reads as the project checkout's status — show
      // nothing rather than another branch's changes (the old GIT tab's rule).
      .then((g) => setGitFiles(g.is_repo && (!branch || g.branch === branch) ? g.files : []))
      .catch(() => setGitFiles([]))
      .finally(() => setGitBusy(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadGit(); setHeads({}); }, [project, branch]);
  const changed = useMemo(() => new Set(gitFiles.map((f) => f.path)), [gitFiles]);
  // A changed file shows its changes in the gutter; CHANGES opens them inline.
  useEffect(() => {
    if (open && changed.has(open)) setDiffs((d) => (d[open] ? d : { ...d, [open]: "gutter" }));
  }, [open, changed]);
  const diffMode = open ? diffs[open] : undefined;
  const head = open ? heads[open] : undefined;
  const diffOn = !!diffMode && head != null;
  useEffect(() => {
    if (!open || !diffMode || head !== undefined) return;
    let live = true;
    void api.fileHead(project, open, branch || undefined)
      .then((r) => { if (live) setHeads((h) => ({ ...h, [open]: r.ok ? r.content ?? "" : null })); })
      .catch(() => { if (live) setHeads((h) => ({ ...h, [open]: null })); });
    return () => { live = false; };
  }, [open, diffMode, head, project, branch]);
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !open) return;
    v.dispatch({ effects: diffComp.reconfigure(diffExt(head, diffMode)) });
    if (head != null && diffMode && firstChunk.current === open) {
      firstChunk.current = "";
      const c = getChunks(v.state)?.chunks[0];
      if (c) v.dispatch({ selection: { anchor: c.fromB }, effects: EditorView.scrollIntoView(c.fromB, { y: "center" }) });
    }
  }, [open, head, diffMode, editable, meta]);

  function stepChange(dir: 1 | -1) {
    const v = viewRef.current;
    if (!v) return;
    (dir > 0 ? goToNextChunk : goToPreviousChunk)(v);
    v.focus();
  }
  function openChanged(path: string) {
    const v = viewRef.current;
    const c = path === open && diffs[path] === "inline" && v ? getChunks(v.state)?.chunks[0] : undefined;
    if (v && c) { v.dispatch({ selection: { anchor: c.fromB }, effects: EditorView.scrollIntoView(c.fromB, { y: "center" }) }); v.focus(); return; }
    firstChunk.current = path;
    setDiffs((d) => ({ ...d, [path]: "inline" }));
    jump({ path, line: 1 });
  }
  const review = () => ask(`Review the uncommitted changes on ${branch || "this branch"}: ${gitFiles.map((f) => `\`${f.path}\``).join(", ")}. Lead with anything that's wrong.`);
  const toGit = onOpenGit && (() => {
    if (dirty || tabs.some(isDirty)) { flash("save first — closing the window drops unsaved edits"); return; }
    onOpenGit();
  });

  // The title bar's ⌘P box.
  if (bus) bus.current.palette = () => setPalQ("");

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

  // "Send selection to chat" closes the modal, and closing it drops every tab's
  // unsaved buffer, so it asks here first; read through a ref, the view's
  // registration outlives the render that made it.
  const leaveOk = useRef<() => boolean>(() => true);
  leaveOk.current = () => {
    if (!dirty && !tabs.some(isDirty)) return true;
    flash("quoted into the prompt — unsaved edits keep the editor open");
    return false;
  };

  async function closeTab(path: string) {
    if (isDirty(path) && !(await askConfirm(`${path} has unsaved changes — close it anyway?`, { ok: "Close", danger: true }))) return;
    bufs.current.delete(path);
    const rest = tabs.filter((p) => p !== path);
    setTabs(rest);
    setPeek((p) => (p === path ? null : p));
    if (path === open) setOpen(nextFocus(tabs, path, rest));
  }

  async function closeAll() {
    const unsaved = tabs.filter(isDirty).length;
    if (unsaved && !(await askConfirm(`${unsaved} open file${unsaved === 1 ? " has" : "s have"} unsaved changes — close anyway?`, { ok: "Close", danger: true }))) return;
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
  function showView(v: SideView) { setView(v); setSideOpen(true); }

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
    setMapOpen(false);
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
    { label: "Close Editor", key: "Ctrl+F4", alt: "Alt+W", off: !open, run: () => { if (open) void closeTab(open); } },
    { label: "Close All Editors", off: !tabs.length, run: () => void closeAll() },
    { label: "Show Explorer", key: "Ctrl+Shift+E", run: () => { showView("explorer"); if (open) reveal(open); } },
    { label: "Find in Files", key: "Ctrl+Shift+F", run: () => showView("search") },
    { label: "Go to Definition", key: "F12", off: !editable, run: () => void goDef() },
    { label: "Peek Definition", key: "Alt+F12", off: !editable, run: () => void peekDef() },
    { label: "Find All References", key: "Shift+F12", off: !editable, run: () => void findRefs() },
    { label: "Go Back", show: IS_MAC ? "Ctrl+-" : "Ctrl+Alt+-", off: !nav.back.length, run: goBack },
    { label: "Go Forward", show: "Ctrl+Shift+-", off: !nav.fwd.length, run: goFwd },
    { label: "Show Outline", run: () => showView("outline") },
    { label: "Show Changes", key: "Ctrl+Shift+G", run: () => { showView("changes"); loadGit(); } },
    { label: "Next Change", key: "Alt+F5", off: !diffOn, run: () => stepChange(1) },
    { label: "Previous Change", key: "Shift+Alt+F5", off: !diffOn, run: () => stepChange(-1) },
    { label: diffMode === "inline" ? "Diff: Gutter Only" : "Diff: Inline", off: !diffOn,
      run: () => { if (open) setDiffs((d) => ({ ...d, [open]: d[open] === "inline" ? "gutter" : "inline" })); } },
    { label: "Toggle Terminal", key: "Ctrl+`", off: !onToggleTerm, run: () => onToggleTerm?.() },
    ...(mapView ? [{ label: mapOpen ? "Back to the Code" : "Show Project Map", run: () => setMapOpen((o) => !o) }] : []),
    { label: "Toggle Side Bar", key: "Ctrl+B", run: () => setSideOpen((o) => !o) },
    { label: allCollapsed ? "Expand Folders in Explorer" : "Collapse Folders in Explorer",
      run: () => { showView("explorer"); setCollapsed(allCollapsed ? new Set() : new Set(dirs)); } },
    { label: "Refresh Explorer", run: () => void loadTree() },
    { label: preview !== null ? "Back to the Editor" : isSvg ? "Open SVG Preview" : "Open Markdown Preview",
      off: !editable || !canPreview,
      run: () => setPreview((p) => (p === null ? viewRef.current?.state.doc.toString() ?? meta?.content ?? "" : null)) },
    { label: `Format on Save — ${prefs.formatOnSave ? "on" : "off"}`,
      run: () => setPrefs((p) => ({ ...p, formatOnSave: !p.formatOnSave })) },
    { label: `Toggle Word Wrap — ${prefs.wordWrap ? "on" : "off"}`, key: "Alt+Z",
      run: () => setPrefs((p) => ({ ...p, wordWrap: !p.wordWrap })) },
    { label: "Increase Font Size", key: "Ctrl+=", alt: "Ctrl++",
      run: () => setPrefs((p) => ({ ...p, fontSize: clampFont(p.fontSize + 1) })) },
    { label: "Decrease Font Size", key: "Ctrl+-",
      run: () => setPrefs((p) => ({ ...p, fontSize: clampFont(p.fontSize - 1) })) },
    { label: `Vim Mode — ${prefs.vim ? "on" : "off"}`,
      run: () => setPrefs((p) => ({ ...p, vim: !p.vim })) },
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
      .map((c) => ({ path: "", label: c.label, sub: c.key ?? c.show ?? "", run: c.run }));

  useEffect(() => { setPalIdx(0); }, [palQ]);

  /* The bindings, matched against CMDS. Captured on window, so Ctrl-S beats the
     browser's Save Page and the palette's Escape doesn't close the whole modal.
     Held in a ref and rebuilt each render: the listener is registered once, but
     every command still runs against current state. */
  keyRef.current = (e: KeyboardEvent) => {
    if (e.key === "Escape" && palQ !== null) { e.preventDefault(); e.stopPropagation(); setPalQ(null); return; }
    // Before App's Escape, which would close the whole window.
    if (e.key === "Escape" && viewRef.current && peekOpen(viewRef.current.state)) {
      e.preventDefault(); e.stopPropagation();
      viewRef.current.dispatch({ effects: peekAt.of(null) });
      return;
    }
    // Back/forward: ⌃- ⌃⇧- on a Mac (⌘- is the font size), Ctrl+Alt+- and
    // Ctrl+Shift+- elsewhere. By `code`: Shift and Alt change `key`.
    if (e.code === "Minus" && (IS_MAC ? e.ctrlKey && !e.metaKey && !e.altKey : e.ctrlKey && (e.altKey || e.shiftKey))) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) goFwd(); else goBack();
      return;
    }
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
        onClick: () => void askConfirm(`Delete ${target.path}${target.dir ? " and everything in it" : ""}?`, { ok: "Delete", danger: true })
          .then((yes) => { if (yes) void runOp("delete", target.path); }),
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

  const lineCount = editable ? (meta?.content ?? "").split("\n").length : 0;
  // Indent shown the way VS Code shows it, so a wrong .editorconfig is visible.
  const indentLabel = meta?.indent === "\t" ? "tab" : `${meta?.tab_size ?? 2} spaces`;
  const statusRight = note
    || (meta && !meta.ok ? (meta.error || "can't open") : "")
    || (meta?.media ? `${meta.mime} · ${Math.round((meta.size ?? 0) / 1024)} KB`
      : meta?.binary ? "binary file" : meta?.too_large ? `too large · ${Math.round((meta.size ?? 0) / 1024)} KB`
      : editable ? `${lang || "…"} · ${indentLabel} · utf-8 · ${lineCount}L` : "");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}
      // a mouse's back/forward buttons walk the same history as ‹ ›
      onMouseUp={(e) => { if (e.button === 3) { e.preventDefault(); goBack(); } else if (e.button === 4) { e.preventDefault(); goFwd(); } }}>
      {/* Fills the window exactly — no floor. A floor taller than the body
          made the whole window scroll, so a long file list pushed the buffer out
          of view; explorer and buffer scroll inside their own columns. */}
      <div style={{ position: "relative", display: "grid", gridTemplateColumns: `44px ${sideOpen ? `${sideW}px ` : ""}1fr`, flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* activity bar — VS Code's icon rail: picks the side view, and clicking
            the one already showing collapses the bar (same as Ctrl-B). */}
        <div style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4, gap: 2, background: "color-mix(in srgb, var(--panel2) 55%, transparent)" }}>
          {([
            { k: "explorer", I: Files, t: "Explorer · Ctrl-Shift-E" },
            { k: "search", I: Search, t: "Search in files · Ctrl-Shift-F" },
            { k: "outline", I: ListTree, t: "Outline — this file's definitions" },
            { k: "changes", I: GitCompare, t: "Changes · Ctrl-Shift-G", n: gitFiles.length },
          ] as { k: SideView; I: typeof Files; t: string; n?: number }[]).map(({ k, I, t, n }) => {
            const on = sideOpen && view === k;
            return (
              <button key={k} title={t} aria-label={t} {...hp(`act:${k}`)}
                onClick={() => { if (on) setSideOpen(false); else { showView(k); if (k === "changes") loadGit(); } }}
                style={{ position: "relative", appearance: "none", cursor: "pointer", border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", width: 44, height: 42, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, color: on ? "var(--txb)" : hov === `act:${k}` ? "var(--txh)" : "var(--txd)" }}>
                <I size={18} strokeWidth={1.6} style={{ marginLeft: -2 }} />
                {/* results waiting behind a view you're not looking at */}
                {k === "search" && hits.length > 0 && !on && (
                  <span style={{ position: "absolute", top: 7, right: 7, width: 5, height: 5, borderRadius: "50%", background: "var(--acc)" }} />
                )}
                {!!n && (
                  <span style={{ position: "absolute", top: 6, right: 4, minWidth: 14, height: 14, borderRadius: 7, padding: "0 3px", boxSizing: "border-box", background: "var(--acc)", color: "var(--acc-on)", fontSize: 9, lineHeight: "14px", textAlign: "center", fontWeight: 700 }}>{n > 99 ? "99+" : n}</span>
                )}
              </button>
            );
          })}
          {mapView && (
            <button title={mapOpen ? "back to the code" : "the project map"} aria-label="project map" {...hp("act:map")}
              onClick={() => setMapOpen((o) => !o)}
              style={{ appearance: "none", cursor: "pointer", border: 0, borderLeft: `2px solid ${mapOpen ? "var(--acc)" : "transparent"}`, background: mapOpen ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", width: 44, height: 42, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, color: mapOpen ? "var(--txb)" : hov === "act:map" ? "var(--txh)" : "var(--txd)" }}>
              <Waypoints size={18} strokeWidth={1.6} style={{ marginLeft: -2 }} />
            </button>
          )}
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
                      <FileIcon name={path} size={14} />
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
          ) : view === "outline" ? (
            <OutlineSide store={curStore} file={open} onJump={(n) => { if (open) jump({ path: open, line: n }); }} />
          ) : view === "changes" ? (
            <ChangesSide store={curStore} branch={branch} files={gitFiles} loading={gitBusy} edited={edited} open={open}
              onOpen={openChanged} onPrev={() => stepChange(-1)} onNext={() => stepChange(1)}
              onCommit={toGit || undefined} onReview={onAsk ? review : undefined} />
          ) : view === "refs" && refs ? (
            <RefsView title={refs.title} word={refs.word} busy={refs.busy} groups={byFile(refs.hits)} defs={refs.defs} here={refs.here}
              onOpen={(h) => jump(h)} onAsk={onAsk ? () => askAbout(refs.word, refs.hits, refs.defs) : undefined}
              onClose={() => { setRefs(null); showView("explorer"); }} />
          ) : (
          <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px", flex: "none" }}>
            <span className="caps" style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Explorer · {paths.length}</span>
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
                onContextMenu={(e) => onRowCtx(e, r.path, true)} title={isIgnored(r.path) ? `${r.path} — git-ignored` : r.path}
                {...dragSourceProps(r.path)} {...dragTargetProps(r.path)}
                style={{ width: "100%", appearance: "none", border: 0, background: dropDir === r.path ? "color-mix(in srgb, var(--acc) 16%, transparent)" : undefined, opacity: drag === r.path ? 0.45 : isIgnored(r.path) ? 0.5 : 1, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
                <span style={{ fontSize: "var(--t8)", color: "var(--txd)", width: 9, flex: "none", textAlign: "center" }}>{collapsed.has(r.path) ? "▸" : "▾"}</span>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flex: "none", color: "var(--txd)" }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                <span style={{ fontSize: "var(--t11)", color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.name}</span>
              </button>
            ) : (
              <button key={r.key} className="trow" onClick={() => peekTab(r.path)} onDoubleClick={() => openTab(r.path)}
                ref={r.path === open ? rowRef : undefined}
                onContextMenu={(e) => onRowCtx(e, r.path, false)} title={isIgnored(r.path) ? `${r.path} — git-ignored` : r.path}
                {...dragSourceProps(r.path)} {...dragTargetProps(parentOf(r.path))}
                style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${r.path === open ? "var(--acc)" : "transparent"}`, background: r.path === open ? "color-mix(in srgb, var(--acc) 8%, transparent)" : undefined, opacity: drag === r.path ? 0.45 : isIgnored(r.path) && r.path !== open ? 0.5 : 1, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
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
          {mapOpen && mapView && <div className="mscroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 18 }}>{mapView}</div>}
          {/* Hidden, not unmounted, under the map: CodeMirror keeps its buffer. */}
          <div style={{ display: mapOpen && mapView ? "none" : "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
                    onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void closeTab(p); } }}
                    style={{ display: "flex", alignItems: "center", gap: 6, flex: "none", maxWidth: 190, padding: "5px 8px 5px 10px", cursor: "pointer", borderRight: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", borderTop: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--panel3) 70%, transparent)" : hov === `tab:${p}` ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent" }}>
                    <span onClick={() => { setOpen(p); setMapOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <FileIcon name={name} size={14} />
                      {/* italic = the preview tab, the one the next single click replaces */}
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", fontStyle: p === peek ? "italic" : "normal", color: on ? "var(--txb)" : "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                    </span>
                    <button onClick={() => void closeTab(p)} title="close" {...hp(`tabx:${p}`)}
                      style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", flex: "none", lineHeight: 1, padding: "1px 2px", fontFamily: "'JetBrains Mono',monospace", fontSize: mod ? "var(--t12)" : "var(--t10)", color: mod ? "var(--warn)" : hov === `tabx:${p}` ? "var(--txb)" : "var(--txd)" }}>
                      {mod && hov !== `tabx:${p}` ? "●" : "✕"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {open && (
            <Crumbs store={curStore} path={open} canBack={nav.back.length > 0} canFwd={nav.fwd.length > 0} onBack={goBack} onFwd={goFwd}
              onLine={(n) => { if (viewRef.current) gotoLine(viewRef.current, n); }}
              diff={diffOn && diffMode ? { mode: diffMode, set: (m) => setDiffs((d) => ({ ...d, [open]: m })), step: stepChange } : undefined} />
          )}
          <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
            {editable ? (
              <>
                {/* hidden, not unmounted, while previewing — CodeMirror keeps the buffer (and its unsaved edits) */}
                <div ref={hostRef} className="mscroll" data-ctx-type="editor" data-ctx-id="editor" data-ctx-label={open ?? undefined}
                  style={{ position: "absolute", inset: 0, overflow: "auto", visibility: preview === null ? "visible" : "hidden" }} />
                {preview !== null && (
                  <div className="mscroll" style={{ position: "absolute", inset: 0, overflow: "auto", padding: "14px 18px", fontSize: "var(--t125)", lineHeight: 1.65, color: "var(--tx)" }}>
                    {/* encodeURIComponent, not base64: the buffer can hold any
                        UTF-8 and btoa only takes latin-1 */}
                    {isSvg
                      ? <img src={`data:image/svg+xml,${encodeURIComponent(preview)}`} alt={open ?? ""} style={{ display: "block", maxWidth: "100%", margin: "0 auto" }} />
                      : <Markdown>{preview}</Markdown>}
                  </div>
                )}
              </>
            ) : meta?.media ? (
              <MediaView src={meta.media} mime={meta.mime ?? ""} name={open ?? ""} />
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", color: "var(--txd)" }}>
                {!open ? "Select a file to edit."
                  : !meta ? "Loading…"
                  : !meta.ok ? (meta.error || "Can't open this file.")
                  : meta.binary ? "Binary file — not editable here."
                  : meta.too_large ? `Too large to open here — ${Math.round((meta.size ?? 0) / 1024 / 1024 * 10) / 10} MB.`
                  : ""}
              </div>
            )}
          </div>
          </div>
          {drawer}
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
      <StatusBar store={curStore} branch={branch} editable={editable} diffOn={diffOn}
        chip={saving ? "SAVING" : dirty ? "UNSAVED" : preview !== null ? "VIEW" : diffOn && diffMode === "inline" ? "DIFF" : "EDIT"}
        chipBg={dirty ? "var(--warn)" : "var(--acc)"} info={statusRight} lit={!!note}
        actions={<>
          {editable && (
            <button onClick={() => void format()} disabled={fmting || meta?.formatter === false}
              title={meta?.formatter === false ? "no formatter installed for this file type" : "format (Shift-Alt-F)"} {...hp("fmt")}
              style={{ appearance: "none", cursor: fmting || meta?.formatter === false ? "not-allowed" : "pointer", height: 18, border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", background: hov === "fmt" && !fmting && meta?.formatter !== false ? "color-mix(in srgb, var(--purple) 14%, transparent)" : "transparent", color: "var(--purple)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, padding: "0 8px", opacity: fmting || meta?.formatter === false ? 0.45 : 1, display: "flex", alignItems: "center", gap: 5 }}>
              <AlignLeft size={11} strokeWidth={1.9} />{fmting ? "FORMATTING" : "FORMAT"}</button>
          )}
          {editable && canPreview && (
            <button onClick={() => setPreview((p) => (p === null ? viewRef.current?.state.doc.toString() ?? meta?.content ?? "" : null))}
              title={preview === null ? (isSvg ? "preview the rendered svg" : "preview rendered markdown") : "back to the editor"} {...hp("mdv")}
              style={{ appearance: "none", cursor: "pointer", height: 18, border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: hov === "mdv" || preview !== null ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "transparent", color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, padding: "0 8px", display: "flex", alignItems: "center", gap: 5 }}>
              {preview === null ? <><Eye size={11} strokeWidth={1.9} />VIEW</> : <><Pencil size={11} strokeWidth={1.9} />EDIT</>}</button>
          )}
          <button onClick={() => void save()} disabled={!editable || saving || !dirty} title="save (Ctrl-S / :w)" {...hp("save")}
            style={{ appearance: "none", cursor: editable && dirty && !saving ? "pointer" : "not-allowed", height: 18, border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", background: hov === "save" && editable && dirty ? "color-mix(in srgb, var(--ok) 14%, transparent)" : "transparent", color: "var(--ok)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, padding: "0 8px", opacity: editable && dirty && !saving ? 1 : 0.45, display: "flex", alignItems: "center", gap: 5 }}><Save size={11} strokeWidth={1.9} />SAVE</button>
        </>} />
      {ctx && (
        <ContextMenu ctx={{ x: ctx.x, y: ctx.y, type: ctx.dir ? "folder" : "file", id: ctx.path, label: ctx.path || "repo root" }}
          items={ctxItems(ctx)} onClose={() => setCtx(null)} />
      )}
    </div>
  );
}

/* ---- the pieces that follow the cursor (Cur), outside EditorTab so a cursor
   move re-renders them alone ---- */

const MONO = "'JetBrains Mono',monospace";

/** ‹ › history, then path › file › the definitions the cursor is in (click one
 *  to go to its first line). With the diff on: INLINE | GUTTER and ‹ n/m ›. */
function Crumbs({ store, path, canBack, canFwd, onBack, onFwd, onLine, diff }: {
  store: CurStore; path: string; canBack: boolean; canFwd: boolean; onBack: () => void; onFwd: () => void;
  onLine: (n: number) => void;
  diff?: { mode: "inline" | "gutter"; set: (m: "inline" | "gutter") => void; step: (d: 1 | -1) => void };
}) {
  const cur = useSyncExternalStore(store.sub, store.get);
  const segs = path.split("/"), file = segs[segs.length - 1], dirs = segs.slice(0, -1);
  const shown = dirs.length > 4 ? ["…", ...dirs.slice(-4)] : dirs;
  const sep = <span style={{ color: "var(--txg)", flex: "none" }}>›</span>;
  const nav = (on: boolean, title: string, run: () => void, I: typeof ChevronLeft) => (
    <button onClick={run} disabled={!on} title={title} aria-label={title} className="trow"
      style={{ appearance: "none", border: 0, background: "transparent", cursor: on ? "pointer" : "default", color: on ? "var(--txh)" : "var(--txg)", display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, flex: "none" }}>
      <I size={14} strokeWidth={1.8} /></button>
  );
  const seg = (m: "inline" | "gutter") => (
    <button key={m} onClick={() => diff?.set(m)} className="caps"
      style={{ appearance: "none", border: 0, cursor: "pointer", padding: "0 8px", height: 19, fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, color: diff?.mode === m ? "var(--txb)" : "var(--txl)", background: diff?.mode === m ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "transparent" }}>{m}</button>
  );
  return (
    <div style={{ flex: "none", height: 27, display: "flex", alignItems: "center", gap: 5, padding: "0 10px 0 6px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", fontFamily: MONO, fontSize: "var(--t10)", color: "var(--txl)", whiteSpace: "nowrap", overflow: "hidden" }}>
      {nav(canBack, `back · ${IS_MAC ? "Ctrl -" : "Ctrl-Alt -"}`, onBack, ChevronLeft)}
      {nav(canFwd, "forward · Ctrl-Shift -", onFwd, ChevronRight)}
      <span style={{ width: 4, flex: "none" }} />
      {shown.map((d, i) => <Fragment key={i}><span style={{ flex: "none" }}>{d}</span>{sep}</Fragment>)}
      <span style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--txh)", flex: "none" }}><FileIcon name={file} size={13} />{file}</span>
      {cur.chain.map((x, i) => {
        const [g, c] = kindOf(x.kind);
        return (
          <Fragment key={x.from}>{sep}
            <button onClick={() => onLine(x.line)} title={`${x.kind} · line ${x.line}`} className="trow"
              style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "0 2px", color: i === cur.chain.length - 1 ? "var(--txb)" : "var(--txm)", fontFamily: "inherit", fontSize: "inherit", flex: "none" }}>
              <span style={{ color: c, fontStyle: g === "ƒ" ? "italic" : "normal" }}>{g}</span>{x.name}</button>
          </Fragment>
        );
      })}
      <span style={{ flex: 1 }} />
      {diff && <>
        <span style={{ display: "flex", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", overflow: "hidden", flex: "none" }}>{seg("inline")}{seg("gutter")}</span>
        {cur.chunk && <span style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 6, color: "var(--txm)", flex: "none" }}>
          {nav(true, "previous change · Shift-Alt-F5", () => diff.step(-1), ChevronLeft)}
          <span>{cur.chunk.i}/{cur.chunk.n}</span>
          {nav(true, "next change · Alt-F5", () => diff.step(1), ChevronRight)}
        </span>}
      </>}
    </div>
  );
}

/** One row, the window's whole width: mode · branch · Ln, Col · the definition
 *  you're in · the word's count or the diff's place · file facts · actions. */
function StatusBar({ store, branch, editable, diffOn, chip, chipBg, info, lit, actions }: {
  store: CurStore; branch: string; editable: boolean; diffOn: boolean; chip: string; chipBg: string;
  info: string; lit: boolean; actions: ReactNode;
}) {
  const cur = useSyncExternalStore(store.sub, store.get);
  const sym = cur.chain[cur.chain.length - 1];
  const item = (child: ReactNode, st?: React.CSSProperties) => (
    <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px", whiteSpace: "nowrap", flex: "none", ...st }}>{child}</span>
  );
  return (
    <div style={{ height: 25, flex: "none", display: "flex", alignItems: "stretch", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", fontFamily: MONO, fontSize: "var(--t10)", color: "var(--txm)", background: "color-mix(in srgb, var(--acc) 4%, transparent)" }}>
      <span style={{ background: chipBg, color: "var(--acc-on)", fontWeight: 700, letterSpacing: 1.5, padding: "0 12px", display: "flex", alignItems: "center", flex: "none" }}>{chip}</span>
      {item(<>⎇ {branch || "—"}</>, { color: "var(--purple)" })}
      {editable && item(`Ln ${cur.line}, Col ${cur.col}`)}
      {editable && sym && item(<><span style={{ color: "var(--acc)", fontStyle: "italic" }}>ƒ</span>{sym.name}</>, { color: "var(--txh)" })}
      {editable && (diffOn
        ? item(cur.chunk ? `change ${cur.chunk.i} of ${cur.chunk.n} · vs HEAD` : "no changes vs HEAD")
        : cur.word && cur.uses > 1 ? item(<><span style={{ color: "var(--acc)" }}>{cur.word}</span>· {cur.uses} in file</>) : null)}
      <span style={{ flex: 1, minWidth: 8 }} />
      <span style={{ display: "flex", alignItems: "center", padding: "0 10px", color: lit ? "#a7e6c3" : "var(--txd)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{info}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px 0 4px", flex: "none" }}>{actions}</span>
    </div>
  );
}

function OutlineSide({ store, file, onJump }: { store: CurStore; file: string | null; onJump: (line: number) => void }) {
  const cur = useSyncExternalStore(store.sub, store.get);
  return <OutlineView file={file} symbols={cur.syms} current={cur.chain[cur.chain.length - 1]} onJump={onJump} />;
}

function ChangesSide({ store, ...rest }: { store: CurStore } & Omit<ComponentProps<typeof ChangesView>, "chunk">) {
  const cur = useSyncExternalStore(store.sub, store.get);
  return <ChangesView {...rest} chunk={cur.chunk} />;
}
