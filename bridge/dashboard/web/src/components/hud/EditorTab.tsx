import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { api, type FileContent, type GrepHit } from "../../api";
import { ContextMenu, type CtxItem } from "./ContextMenu";

/* EDITOR tab — a real file editor (not the diff viewer it used to be). Browses
   the whole working tree of the selected branch/worktree, opens any file into an
   editable CodeMirror 6 buffer with syntax highlighting, and saves to disk via
   Ctrl-S / :w (POST /local/files/write). Binary/oversized files load read-only
   with a placeholder.

   VS Code-ish extras: a quick-open palette (Ctrl-P files · Ctrl-Shift-O symbols
   in the open file · Ctrl-Shift-F search in files), expand/collapse-all in the
   explorer, reveal-the-open-file, and new/rename/delete via right-click. */

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

// One row in the quick-open palette (a file, a symbol, or a search hit).
interface PalItem {
  path: string;
  line?: number;
  label: string;
  sub: string;
}

export interface TreeRow {
  key: string;
  dir: boolean;
  depth: number;
  name: string;
  path: string;
}

const EXT_COLOR: Record<string, string> = {
  ts: "var(--info)", tsx: "var(--info)", js: "var(--warn)", jsx: "var(--warn)", mjs: "var(--warn)", cjs: "var(--warn)",
  css: "var(--purple)", scss: "var(--purple)", md: "var(--txm)", json: "var(--warn)", py: "var(--ok)",
  html: "var(--err)", htm: "var(--err)", toml: "var(--txm)", yml: "var(--txm)", yaml: "var(--txm)",
};
export function iconColor(name: string): string {
  return EXT_COLOR[name.split(".").pop()?.toLowerCase() ?? ""] ?? "#7fa8a0";
}

/* Flatten a sorted path list into a collapsible directory tree (dirs before
   their files, honoring the collapsed set). */
export function buildRows(paths: string[], collapsed: Set<string>): TreeRow[] {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
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

// Definitions worth jumping to, across the languages the editor highlights.
const SYMBOL_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(function|class|def|interface|type|enum|struct|fn)\s+([A-Za-z_$][\w$]*)|(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/;
const NOT_SYMBOL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "with"]);

function symbolsIn(doc: string): { name: string; kind: string; line: number }[] {
  const out: { name: string; kind: string; line: number }[] = [];
  doc.split("\n").forEach((text, i) => {
    const m = SYMBOL_RE.exec(text);
    if (!m) return;
    const name = m[2] ?? m[4] ?? m[5];
    const kind = m[1] ?? m[3] ?? "method";
    if (!name || NOT_SYMBOL.has(name)) return;
    out.push({ name, kind, line: i + 1 });
  });
  return out;
}

function langFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext))
    return [javascript({ typescript: ext.startsWith("ts"), jsx: ext.endsWith("x") })];
  if (ext === "json") return [json()];
  if (ext === "css" || ext === "scss") return [css()];
  if (ext === "html" || ext === "htm") return [html()];
  if (ext === "py") return [python()];
  if (ext === "md" || ext === "markdown") return [markdown()];
  return [];
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
  "&": { backgroundColor: "transparent", color: "var(--txh)", height: "100%", fontSize: "12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "'JetBrains Mono',monospace", caretColor: "var(--acc)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--acc)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--acc) 18%, transparent)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--txg)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--acc) 4.5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--txd)" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono',monospace", lineHeight: "1.6" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--purple) 15%, transparent)" },
}, { dark: true });

export function EditorTab({ project, branch, branchOpts, onPickBranch, initialFile }: Props) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [paths, setPaths] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);      // path being edited
  const [meta, setMeta] = useState<FileContent | null>(null); // load result (binary/too_large flags)
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cmd, setCmd] = useState("");
  const [note, setNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  // quick-open palette: null = closed; "" files, "@…" symbols, "#…" grep
  const [palQ, setPalQ] = useState<string | null>(null);
  const [palIdx, setPalIdx] = useState(0);
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [grepBusy, setGrepBusy] = useState(false);
  // explorer file management: right-click menu + the new/rename input bar
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);      // row being dragged
  const [dropDir, setDropDir] = useState<string | null>(null); // folder under the cursor
  const [edit, setEdit] = useState<{ mode: "new" | "newdir" | "rename"; path: string; value: string } | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const baseRef = useRef("");                     // last-saved content, for the dirty check
  const saveRef = useRef<() => void>(() => {});   // latest save fn, for the Ctrl-S keymap
  const noteT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpRef = useRef(0);                      // line to scroll to once the buffer mounts
  const rowRef = useRef<HTMLButtonElement | null>(null); // the open file's tree row

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
  // (opened from the sidebar explorer) starts open — the tree is fully expanded
  // here, so its row renders and the scroll-into-view below reveals it.
  useEffect(() => {
    let live = true;
    setOpen(initialFile ?? null); setMeta(null); setCollapsed(new Set());
    void api.filesTree(project, branch || undefined)
      .then((r) => { if (live) setPaths(r.files); })
      .catch(() => { if (live) setPaths([]); });
    return () => { live = false; };
  }, [project, branch, initialFile]);

  const rows = useMemo(() => buildRows(paths, collapsed), [paths, collapsed]);
  const dirs = useMemo(() => dirsOf(paths), [paths]);
  const allCollapsed = dirs.length > 0 && collapsed.size >= dirs.length;

  // Keep the open file's row visible when it's opened from the palette.
  useEffect(() => { rowRef.current?.scrollIntoView({ block: "nearest" }); }, [open, rows]);

  // Load a file's contents when `open` changes.
  useEffect(() => {
    if (!open) { setMeta(null); return; }
    let live = true;
    setMeta(null); setDirty(false);
    void api.fileRead(project, open, branch || undefined)
      .then((r) => { if (live) { setMeta(r); baseRef.current = r.content ?? ""; } })
      .catch((e) => { if (live) setMeta({ ok: false, error: (e as Error).message }); });
    return () => { live = false; };
  }, [open, project, branch]);

  const editable = !!meta && meta.ok && !meta.binary && !meta.too_large;

  // (Re)build the CodeMirror view when an editable file's contents arrive.
  useEffect(() => {
    if (!hostRef.current || !editable || !open || !meta) {
      if (meta && !editable) jumpRef.current = 0;   // binary/too large: no line to jump to
      return;
    }
    const state = EditorState.create({
      doc: meta.content ?? "",
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(crtHighlight),
        crtTheme,
        langFor(open),
        // Mod-s first so it wins over any default binding; then editing keymaps.
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { saveRef.current(); return true; } },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setDirty(u.state.doc.toString() !== baseRef.current);
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    view.focus();
    if (jumpRef.current) { gotoLine(view, jumpRef.current); jumpRef.current = 0; }
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, open, meta]);

  async function save() {
    const v = viewRef.current;
    if (!v || !open || saving) return;
    const content = v.state.doc.toString();
    setSaving(true);
    try {
      const r = await api.fileWrite(project, open, content, branch || undefined);
      if (r.ok) { baseRef.current = content; setDirty(false); flash(`wrote ${open}`); }
      else flash(`E212: ${r.error || "write failed"}`);
    } catch (e) {
      flash(`E212: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = () => { void save(); };

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
    setOpen(path);
  }

  const palMode = palQ === null ? "" : palQ.startsWith("@") ? "@" : palQ.startsWith("#") ? "#" : "p";
  const palTerm = palMode === "p" ? (palQ ?? "") : (palQ ?? "").slice(1);

  // `#` searches the whole tree on the bridge — debounced so typing isn't a
  // git grep per keystroke.
  useEffect(() => {
    if (palMode !== "#") return;
    const q = palTerm.trim();
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
  }, [palMode, palTerm, project, branch]);

  const palItems = useMemo<PalItem[]>(() => {
    if (palQ === null) return [];
    const q = palTerm.trim().toLowerCase();
    if (palMode === "#") {
      return hits.map((h) => ({ path: h.path, line: h.line, label: h.text || h.path, sub: `${h.path}:${h.line}` }));
    }
    if (palMode === "@") {
      if (!open) return [];
      const doc = viewRef.current?.state.doc.toString() ?? meta?.content ?? "";
      return symbolsIn(doc)
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
  }, [palQ, palMode, palTerm, paths, hits, open, meta]);

  useEffect(() => { setPalIdx(0); }, [palQ]);

  // Ctrl-P / Ctrl-Shift-O / Ctrl-Shift-F, captured so the modal's own Escape
  // handler doesn't close the whole modal while the palette is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && k === "p") { e.preventDefault(); setPalQ(""); }
      else if (mod && e.shiftKey && k === "o") { e.preventDefault(); setPalQ("@"); }
      else if (mod && e.shiftKey && k === "f") { e.preventDefault(); setPalQ("#"); }
      else if (e.key === "Escape" && palQ !== null) { e.preventDefault(); e.stopPropagation(); setPalQ(null); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [palQ]);

  function onPalKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setPalIdx((i) => Math.min(i + 1, palItems.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPalIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      const it = palItems[palIdx];
      if (it) openFile(it.path, it.line);
    }
  }

  /* ---- explorer file management ---- */

  async function runOp(op: "new" | "newdir" | "rename" | "delete", path: string, to?: string) {
    try {
      const r = await api.fileOp(project, op, path, to, branch || undefined);
      if (!r.ok) { flash(`E212: ${r.error || "failed"}`); return; }
      await loadTree();
      if (op === "rename" && to) {
        if (open === path) setOpen(to);
        else if (open?.startsWith(`${path}/`)) setOpen(`${to}${open.slice(path.length)}`);
        flash(`renamed to ${to}`);
      } else if (op === "delete") {
        if (open === path || open?.startsWith(`${path}/`)) setOpen(null);
        flash(`deleted ${path}`);
      } else if (op === "new") {
        reveal(path);
        setOpen(path);
      } else {
        // The tree comes from `git ls-files`, which can't see an empty folder —
        // so hand the user straight to "new file inside it".
        setEdit({ mode: "new", path, value: `${path}/` });
        flash(`created ${path}/ — add a file to it`);
      }
    } catch (e) {
      flash(`E212: ${(e as Error).message}`);
    }
  }

  // New file/folder go next to the clicked file, or inside the clicked folder.
  function startNew(mode: "new" | "newdir", anchor: string, dir: boolean) {
    const base = dir ? anchor : anchor.includes("/") ? anchor.slice(0, anchor.lastIndexOf("/")) : "";
    setEdit({ mode, path: base, value: base ? `${base}/` : "" });
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
      { icon: "+", label: "New File…", onClick: () => startNew("new", target.path, target.dir) },
      { icon: "▤", label: "New Folder…", onClick: () => startNew("newdir", target.path, target.dir) },
    ];
    if (!target.path) return head;   // right-click on empty space → repo root
    return [
      ...head,
      { divider: true },
      { icon: "✎", label: "Rename…", onClick: () => setEdit({ mode: "rename", path: target.path, value: target.path }) },
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
    else if (c) flash(`E492: not an editor command: ${c}`);
  }

  const lineCount = editable ? (meta?.content ?? "").split("\n").length : 0;
  const statusRight = note
    || (meta && !meta.ok ? (meta.error || "can't open") : "")
    || (meta?.binary ? "binary file" : meta?.too_large ? "too large to edit" : editable ? `utf-8 · ${lineCount}L` : "");

  return (
    <div style={{ animation: "mslide .3s ease both", height: "100%" }}>
      {/* Fills the modal body exactly — no floor. A floor taller than the body
          made the whole modal scroll, so a long file list pushed the buffer out
          of view; explorer and buffer now scroll inside their own columns. */}
      <div style={{ position: "relative", display: "grid", gridTemplateColumns: "230px 1fr", border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", height: "100%", minHeight: 0, overflow: "hidden" }}>
        {/* explorer */}
        <div style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", minHeight: 0, background: "color-mix(in srgb, var(--panel2) 35%, transparent)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px", flex: "none" }}>
            <span style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--txl)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>EXPLORER · {paths.length}</span>
            <span style={{ flex: 1 }} />
            <div style={{ position: "relative", flex: "none" }}>
              <button onClick={() => setMenuOpen((o) => !o)} title="switch branch — worktrees marked" {...hp("br")}
                style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === "br" ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9, padding: "3px 7px", maxWidth: 150 }}>
                <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch || "—"}</span>
                <span style={{ color: "var(--purple-g)", flex: "none" }}>▾</span>
              </button>
              {menuOpen && (
                <div style={{ position: "absolute", top: "calc(100% + 5px)", left: 0, zIndex: 30, minWidth: 210, border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 12px 32px rgba(0,0,0,.6)", padding: 5, animation: "mslide .16s ease both" }}>
                  <div style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", padding: "5px 8px 7px" }}>SWITCH BRANCH</div>
                  {branchOpts.map((b) => (
                    <button key={b.name} onClick={() => { onPickBranch(b.name); setMenuOpen(false); }} {...hp(`bi:${b.name}`)}
                      style={{ width: "100%", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: 0, background: hov === `bi:${b.name}` ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "7px 9px", textAlign: "left" }}>
                      <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                      {b.hasWorktree && <span style={{ fontSize: 7.5, letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", padding: "1px 4px", flex: "none" }}>WORKTREE</span>}
                      {b.on && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* explorer toolbar — quick open · new file/folder · collapse all · refresh */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 8px 7px", flex: "none" }}>
            {([
              { k: "find", g: "⌕", t: "quick open (Ctrl-P) · @ symbols · # search in files", on: () => setPalQ("") },
              { k: "nf", g: "+", t: "new file", on: () => startNew("new", "", true) },
              { k: "nd", g: "▤", t: "new folder", on: () => startNew("newdir", "", true) },
              { k: "col", g: allCollapsed ? "⊞" : "⊟", t: allCollapsed ? "expand all folders" : "collapse all folders", on: () => setCollapsed(allCollapsed ? new Set() : new Set(dirs)) },
              { k: "ref", g: "⟳", t: "refresh file list", on: () => void loadTree() },
            ] as const).map((b) => (
              <button key={b.k} onClick={b.on} title={b.t} {...hp(`tb:${b.k}`)}
                style={{ appearance: "none", cursor: "pointer", border: `1px solid ${hov === `tb:${b.k}` ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, background: hov === `tb:${b.k}` ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, lineHeight: 1, padding: "4px 7px" }}>{b.g}</button>
            ))}
          </div>
          {edit && (
            <div style={{ padding: "0 8px 8px", flex: "none" }}>
              <div style={{ fontSize: 8, letterSpacing: 1.2, color: "var(--txl)", marginBottom: 4 }}>
                {edit.mode === "rename" ? "RENAME" : edit.mode === "newdir" ? "NEW FOLDER" : "NEW FILE"}
              </div>
              <input autoFocus value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") submitEdit(); else if (e.key === "Escape") { e.stopPropagation(); setEdit(null); } }}
                onBlur={() => setEdit(null)} placeholder="path/name"
                style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, padding: "5px 7px" }} />
            </div>
          )}
          <div className="mscroll" onContextMenu={(e) => onRowCtx(e, "", true)} {...dragTargetProps("")}
            style={{ flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 8, outline: dropDir === "" ? "1px dashed color-mix(in srgb, var(--acc) 45%, transparent)" : "none", outlineOffset: -2 }}>
            {rows.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--txl)", padding: "8px 10px" }}>No files on ⎇ {branch || "this branch"}.</div>
            )}
            {rows.map((r) => r.dir ? (
              <button key={r.key} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(r.path)) n.delete(r.path); else n.add(r.path); return n; })}
                onContextMenu={(e) => onRowCtx(e, r.path, true)} title={r.path} {...hp(r.key)}
                {...dragSourceProps(r.path)} {...dragTargetProps(r.path)}
                style={{ width: "100%", appearance: "none", border: 0, background: dropDir === r.path ? "color-mix(in srgb, var(--acc) 16%, transparent)" : hov === r.key ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", opacity: drag === r.path ? 0.45 : 1, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
                <span style={{ fontSize: 8, color: "var(--txd)", width: 9, flex: "none", textAlign: "center" }}>{collapsed.has(r.path) ? "▸" : "▾"}</span>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#7fa8a0" strokeWidth="1.7" style={{ flex: "none" }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                <span style={{ fontSize: 11, color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.name}</span>
              </button>
            ) : (
              <button key={r.key} onClick={() => setOpen(r.path)} ref={r.path === open ? rowRef : undefined}
                onContextMenu={(e) => onRowCtx(e, r.path, false)} title={r.path} {...hp(r.key)}
                {...dragSourceProps(r.path)} {...dragTargetProps(parentOf(r.path))}
                style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${r.path === open ? "var(--acc)" : "transparent"}`, background: r.path === open ? "color-mix(in srgb, var(--acc) 8%, transparent)" : hov === r.key ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", opacity: drag === r.path ? 0.45 : 1, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
                <span style={{ width: 8, height: 10, flex: "none", background: iconColor(r.name), opacity: 0.85 }} />
                <span style={{ fontSize: 11, color: r.path === open ? "var(--txb)" : "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{r.name}</span>
                {r.path === open && dirty && <span style={{ fontSize: 12, color: "var(--warn)", flex: "none", lineHeight: 1 }}>●</span>}
              </button>
            ))}
          </div>
        </div>

        {/* buffer + chrome */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "color-mix(in srgb, var(--panel3) 50%, transparent)" }}>
          <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
            {editable ? (
              <div ref={hostRef} className="mscroll" style={{ position: "absolute", inset: 0, overflow: "auto" }} />
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: "var(--txd)" }}>
                {!open ? "Select a file to edit."
                  : !meta ? "Loading…"
                  : !meta.ok ? (meta.error || "Can't open this file.")
                  : meta.binary ? "Binary file — not editable here."
                  : meta.too_large ? "File is over 1 MB — too large to edit here."
                  : ""}
              </div>
            )}
          </div>
          <div style={{ flex: "none", display: "flex", alignItems: "stretch", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5 }}>
            <span style={{ background: dirty ? "var(--warn)" : "var(--acc)", color: "var(--acc-on)", fontWeight: 700, letterSpacing: 1.5, padding: "5px 12px", flex: "none" }}>{saving ? "SAVING" : dirty ? "UNSAVED" : "EDIT"}</span>
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
              style={{ appearance: "none", cursor: editable && dirty && !saving ? "pointer" : "not-allowed", border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", background: hov === "save" && editable && dirty ? "color-mix(in srgb, var(--ok) 14%, transparent)" : "transparent", color: "var(--ok)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 10px", opacity: editable && dirty && !saving ? 1 : 0.45 }}>▸ SAVE</button>
            <span style={{ color: "var(--acc)", flex: "none" }}>:</span>
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={onCmdKey}
              placeholder="w · wq"
              style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5 }} />
          </div>
        </div>

        {/* quick-open palette — files · @symbols · #search-in-files */}
        {palQ !== null && (
          <>
            <div onClick={() => setPalQ(null)} style={{ position: "absolute", inset: 0, zIndex: 40, background: "color-mix(in srgb, var(--panel3) 55%, transparent)" }} />
            <div style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 41, width: "min(520px, 92%)", border: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 16px 44px rgba(0,0,0,.7)", animation: "mslide .16s ease both" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
                <span style={{ color: "var(--acc)", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, flex: "none" }}>
                  {palMode === "@" ? "@" : palMode === "#" ? "#" : "⌕"}
                </span>
                <input autoFocus value={palQ} onChange={(e) => setPalQ(e.target.value)} onKeyDown={onPalKey}
                  placeholder="file name · @symbol in this file · #search in files"
                  style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} />
                <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--txl)", flex: "none" }}>
                  {grepBusy ? "SEARCHING…" : `${palItems.length}`}
                </span>
              </div>
              <div className="mscroll" style={{ maxHeight: 300, overflowY: "auto" }}>
                {palItems.length === 0 && (
                  <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "10px 12px", fontFamily: "'JetBrains Mono',monospace" }}>
                    {palMode === "@" && !open ? "Open a file first — @ lists its functions."
                      : palMode === "#" && palTerm.trim().length < 2 ? "Type at least 2 characters to search the tree."
                      : grepBusy ? "…" : "No matches."}
                  </div>
                )}
                {palItems.map((it, i) => (
                  <button key={`${it.path}:${it.line ?? 0}:${i}`} onClick={() => openFile(it.path, it.line)}
                    onMouseEnter={() => setPalIdx(i)}
                    style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${i === palIdx ? "var(--acc)" : "transparent"}`, background: i === palIdx ? "color-mix(in srgb, var(--acc) 9%, transparent)" : "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "baseline", gap: 8, padding: "5px 10px" }}>
                    <span style={{ fontSize: 11, color: i === palIdx ? "var(--txb)" : "var(--txh)", flex: "none", maxWidth: "60%", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
                    <span style={{ fontSize: 9.5, color: "var(--txl)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{it.sub}</span>
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
