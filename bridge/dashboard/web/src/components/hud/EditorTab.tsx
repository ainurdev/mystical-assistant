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
import { api, type FileContent } from "../../api";

/* EDITOR tab — a real file editor (not the diff viewer it used to be). Browses
   the whole working tree of the selected branch/worktree, opens any file into an
   editable CodeMirror 6 buffer with syntax highlighting, and saves to disk via
   Ctrl-S / :w (POST /local/files/write). Binary/oversized files load read-only
   with a placeholder. */

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
}

interface TreeRow {
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
function iconColor(name: string): string {
  return EXT_COLOR[name.split(".").pop()?.toLowerCase() ?? ""] ?? "#7fa8a0";
}

/* Flatten a sorted path list into a collapsible directory tree (dirs before
   their files, honoring the collapsed set). */
function buildRows(paths: string[], collapsed: Set<string>): TreeRow[] {
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

// CRT-flavored syntax colors + a transparent editor chrome, so the buffer sits
// on the panel's own dark background rather than CodeMirror's default light one.
const crtHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--purple)" },
  { tag: [t.name, t.propertyName, t.macroName, t.deleted, t.character], color: "var(--txh)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--acc)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name), t.bool], color: "var(--ok)" },
  { tag: [t.typeName, t.className, t.number, t.annotation, t.modifier, t.self, t.namespace], color: "var(--warn)" },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link], color: "var(--acc)" },
  { tag: [t.meta, t.comment], color: "#5a7772", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.string, t.inserted, t.special(t.string)], color: "#a7e6c3" },
  { tag: t.invalid, color: "#f0b0a8" },
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

export function EditorTab({ project, branch, branchOpts, onPickBranch }: Props) {
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

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const baseRef = useRef("");                     // last-saved content, for the dirty check
  const saveRef = useRef<() => void>(() => {});   // latest save fn, for the Ctrl-S keymap
  const noteT = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flash(m: string) {
    setNote(m);
    if (noteT.current) clearTimeout(noteT.current);
    noteT.current = setTimeout(() => setNote(""), 3000);
  }
  useEffect(() => () => { if (noteT.current) clearTimeout(noteT.current); }, []);

  // Load the file list whenever the project/branch changes.
  useEffect(() => {
    let live = true;
    setOpen(null); setMeta(null); setCollapsed(new Set());
    void api.filesTree(project, branch || undefined)
      .then((r) => { if (live) setPaths(r.files); })
      .catch(() => { if (live) setPaths([]); });
    return () => { live = false; };
  }, [project, branch]);

  const rows = useMemo(() => buildRows(paths, collapsed), [paths, collapsed]);

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
    if (!hostRef.current || !editable || !open || !meta) return;
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
    <div style={{ animation: "mslide .3s ease both" }}>
      <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", height: 430, overflow: "hidden" }}>
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
          <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 8 }}>
            {rows.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--txl)", padding: "8px 10px" }}>No files on ⎇ {branch || "this branch"}.</div>
            )}
            {rows.map((r) => r.dir ? (
              <button key={r.key} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(r.path)) n.delete(r.path); else n.add(r.path); return n; })}
                title={r.path} {...hp(r.key)}
                style={{ width: "100%", appearance: "none", border: 0, background: hov === r.key ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
                <span style={{ fontSize: 8, color: "var(--txd)", width: 9, flex: "none", textAlign: "center" }}>{collapsed.has(r.path) ? "▸" : "▾"}</span>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#7fa8a0" strokeWidth="1.7" style={{ flex: "none" }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                <span style={{ fontSize: 11, color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.name}</span>
              </button>
            ) : (
              <button key={r.key} onClick={() => setOpen(r.path)} title={r.path} {...hp(r.key)}
                style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${r.path === open ? "var(--acc)" : "transparent"}`, background: r.path === open ? "color-mix(in srgb, var(--acc) 8%, transparent)" : hov === r.key ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
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
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: "#5a7772" }}>
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
            <span style={{ background: dirty ? "var(--warn)" : "var(--acc)", color: "#06100e", fontWeight: 700, letterSpacing: 1.5, padding: "5px 12px", flex: "none" }}>{saving ? "SAVING" : dirty ? "UNSAVED" : "EDIT"}</span>
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
      </div>
    </div>
  );
}
