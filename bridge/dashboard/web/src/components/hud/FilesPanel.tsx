import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, ChevronRight, Copy, Diff, Folder, FolderOpen, FoldVertical, RotateCw, Sparkle, UnfoldVertical } from "lucide-react";
import { api, type GitFile } from "../../api";
import { buildRows, dirsOf } from "./EditorTab";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { askConfirm } from "../ui/Ask";
import { FileIcon } from "../../lib/fileicon";
import { ignoredMatcher } from "../../lib/gitignored";
import { Skeleton } from "../ui";
import { useLoadingPhase } from "../../lib/loadingPhase";
import { findFiles } from "../../lib/filefind";

/* FILES — a VS Code-ish explorer for the ACTIVE SESSION's working tree
   (project + its branch's worktree). Git-changed files carry their status
   letter and colour, and every folder above one gets a dot, so a change is
   findable without expanding the whole tree. Clicking a file hands it to the
   editor modal. Tree building is shared with the EDITOR tab. The changed-file
   list, the commit box and the graph are the GIT tab's (GitPanel).

   It is the way to a file now that the session header's ⊞ PROJECT is gone, so
   it has a find field (⌘P from anywhere, App): typing swaps the tree for the
   paths that hold the text (lib/filefind), ↑/↓ and ↵ open one, esc clears.

   What the session wrote wears a ✦ (lib/sessionedits), and a closed folder
   counts both kinds of mark inside it: ✦ edited this session, ● uncommitted.
   The file a running turn wrote last pulses. No section of its own — the
   marks live in the tree (.mystical/design-drafts/files-tab, option C). */

// ⌘P asks for the find field from anywhere, sometimes before this panel has
// mounted (the rail was on another tab): the request waits here until it has.
let findWanted = false;
export function requestFileFind(): void {
  findWanted = true;
  window.dispatchEvent(new Event("files:find"));
}

interface Props {
  project: string | null;
  branch?: string;
  // `changed` lets the caller land a dirty file on the GIT tab (diff) instead
  // of the editor, so its changed lines are visible.
  onOpenFile: (path: string, changed: boolean) => void;
  // TEAM: send this file to a teammate (absent while there's no one to send to).
  onSendFile?: (path: string) => void;
  // The session's writes, relative to this tree (lib/sessionedits), and the one
  // its running turn wrote last.
  edited?: Set<string>;
  editing?: string | null;
  // Puts the path in the prompt box (a row's @, and its menu).
  onAddToPrompt?: (path: string) => void;
}

type Row = { key: string; dir: boolean; depth: number; name: string; path: string };

const ST_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");

const IND = 14;   // indent per level; the guide of level i runs down its chevron
const LIVE_BG = "color-mix(in srgb, var(--ok) 9%, transparent)";
const pulse = <span className="sessdot" data-work="true" style={{ flex: "none", width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />;

/* Placeholder rows while the tree loads: [indent, width%]. Shaped like a tree
   rather than a spinner, so the panel's layout is already there when the real
   rows replace it and nothing jumps. */
const SKEL: [number, number][] = [
  [0, 62], [1, 78], [1, 51], [0, 70], [1, 44], [1, 83], [0, 57], [1, 66], [1, 38], [0, 74], [1, 60], [1, 47],
];

/* How many of `paths` sit under each folder, at every level. */
function countAbove(paths: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      out.set(prefix, (out.get(prefix) ?? 0) + 1);
    }
  }
  return out;
}

export function FilesPanel({ project, branch, onOpenFile, onSendFile, edited, editing, onAddToPrompt }: Props) {
  const [paths, setPaths] = useState<string[]>([]);
  // .gitignore'd paths, as prefixes — listed like everything else, just dimmed.
  const [ignored, setIgnored] = useState<string[]>([]);
  const [files, setFiles] = useState<GitFile[]>([]);
  // Folders start closed — a repo tree is thousands of rows in a 358px column.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Has the tree read come back yet? An empty list before the first answer
  // means "not read yet", not "nothing here" — the tree read is ~1s on a big
  // repo, and the panel used to spend it claiming the project was not a git
  // repo, because [] renders the same either way.
  const [treeReady, setTreeReady] = useState(false);
  const [note, setNote] = useState("");
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  // A long tree scrolls the top out of reach — hence the back-to-top button.
  const listRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => { findWanted = false; findRef.current?.focus(); findRef.current?.select(); };
    if (findWanted) focus();
    window.addEventListener("files:find", focus);
    return () => window.removeEventListener("files:find", focus);
  }, []);

  const loadTree = useCallback(async () => {
    if (!project) { setPaths([]); return; }
    try {
      const r = await api.filesTree(project, branch || undefined);
      setPaths(r.files);
      setIgnored(r.ignored ?? []);
      setCollapsed(new Set(dirsOf(r.files)));
    } catch { setPaths([]); setIgnored([]); }
    finally { setTreeReady(true); }
  }, [project, branch]);

  useEffect(() => { void loadTree(); }, [loadTree]);

  const loadGit = useCallback(async () => {
    if (!project) { setFiles([]); return; }
    try {
      const g = await api.git(project, branch || undefined);
      setFiles(g.files);
    } catch { setFiles([]); }
  }, [project, branch]);

  const changed = useMemo(
    () => new Map(files.map((f) => [f.path, f.status])), [files]);

  // Working-tree status, refreshed on the same cadence as the git badges.
  useEffect(() => {
    void loadGit();
    const id = setInterval(() => void loadGit(), 10000);
    return () => clearInterval(id);
  }, [loadGit]);

  const rows: Row[] = useMemo(() => buildRows(paths, collapsed), [paths, collapsed]);
  const isIgnored = useMemo(() => ignoredMatcher(ignored), [ignored]);
  const finding = q.trim() !== "";
  const found = useMemo(() => findFiles(paths, q, 60, isIgnored), [paths, q, isIgnored]);
  // The picked match stays in view while ↑/↓ walk past the list's edge.
  useEffect(() => { listRef.current?.querySelector("[data-sel]")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  const changedDirs = useMemo(() => countAbove(changed.keys()), [changed]);
  // Marks only for files the tree still has: an edit of a since-deleted file has no row.
  const here = useMemo(() => new Set(paths), [paths]);
  const mine = useMemo(() => new Set([...(edited ?? [])].filter((p) => here.has(p))), [edited, here]);
  const mineDirs = useMemo(() => countAbove(mine), [mine]);
  const live = editing && mine.has(editing) ? editing : null;
  const liveDirs = useMemo(() => countAbove(live ? [live] : []), [live]);
  const dirs = useMemo(() => dirsOf(paths), [paths]);
  const allCollapsed = dirs.length > 0 && collapsed.size >= dirs.length;

  const toggleDir = (p: string) =>
    setCollapsed((c) => { const n = new Set(c); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  // Expand only what's needed to show every changed and every edited file.
  const revealChanges = () =>
    setCollapsed((c) => { const n = new Set(c); for (const d of [...changedDirs.keys(), ...mineDirs.keys()]) n.delete(d); return n; });

  async function gitOp(op: "stage" | "unstage" | "discard", paths: string[]) {
    if (!project || !paths.length) return;
    try {
      const r = await api.gitOp(project, op, paths, branch || undefined);
      setNote(r.ok ? "" : r.output || `${op} failed.`);
    } catch (e) { setNote((e as Error).message); }
    void loadGit();
  }

  async function del(path: string) {
    if (!project) return;
    try {
      const r = await api.fileOp(project, "delete", path, undefined, branch || undefined);
      setNote(r.ok ? "" : r.error || "Delete failed.");
    } catch (e) { setNote((e as Error).message); }
    void loadGit();
    void loadTree();
  }

  const copyPath = (p: string) => {
    try { void navigator.clipboard?.writeText(p); setNote(`Copied ${p}`); } catch { /* ignore */ }
  };

  /* Row menu. A changed file can be staged or discarded from here; the GIT
     tab is where the index is worked in full. */
  function ctxItems(t: NonNullable<typeof ctx>): CtxItem[] {
    if (t.dir) return [{ icon: "⧉", label: "Copy Path", onClick: () => copyPath(t.path) }];
    const st = changed.get(t.path);
    const untracked = st === "?";
    const items: CtxItem[] = [
      { icon: "▤", label: "Open File", onClick: () => onOpenFile(t.path, false) },
    ];
    if (st) items.push({ icon: "◫", label: "Open Changes", hint: "diff", onClick: () => onOpenFile(t.path, true) });
    if (onAddToPrompt) items.push({ icon: "@", label: "Add to Prompt", onClick: () => onAddToPrompt(t.path) });
    if (st) {
      items.push({ divider: true });
      items.push({ icon: "+", label: "Stage Changes", onClick: () => void gitOp("stage", [t.path]) });
      items.push({
        icon: "↺", label: "Discard Changes", danger: true,
        hint: untracked ? "never committed — this deletes it" : undefined,
        onClick: () => void askConfirm(untracked
          ? `Delete ${t.path}? It was never committed, so there is nothing to restore.`
          : `Discard your changes to ${t.path}? This can't be undone.`, { ok: untracked ? "Delete" : "Discard", danger: true })
          .then((yes) => { if (yes) void gitOp("discard", [t.path]); }),
      });
    }
    items.push({ divider: true });
    // TEAM (bridge/team.py): never a .env file, which the bridge refuses anyway.
    if (onSendFile && !/^\.env/i.test(t.path.split("/").pop() ?? ""))
      items.push({ icon: "➤", label: "Send to teammate…", hint: "through Rivendell", onClick: () => onSendFile(t.path) });
    items.push({ icon: "⧉", label: "Copy Path", onClick: () => copyPath(t.path) });
    items.push({
      icon: "✕", label: "Delete File", danger: true,
      onClick: () => void askConfirm(`Delete ${t.path} from disk?`, { ok: "Delete", danger: true })
        .then((yes) => { if (yes) void del(t.path); }),
    });
    return items;
  }

  // useLoadingPhase keeps a fast answer (a cached tree) from strobing the
  // placeholder on and off inside one frame budget.
  const skel = useLoadingPhase(!treeReady);

  const tools: { k: string; g: React.ReactNode; t: string; on: () => void }[] = [
    { k: "chg", g: <Diff size={13} />, t: "open the folders with changes", on: revealChanges },
    { k: "col", g: allCollapsed ? <UnfoldVertical size={13} /> : <FoldVertical size={13} />, t: allCollapsed ? "expand all" : "collapse all",
      on: () => setCollapsed(allCollapsed ? new Set() : new Set(dirs)) },
    { k: "ref", g: <RotateCw size={13} />, t: "refresh", on: () => void loadTree() },
  ];

  /* A file row's right end: its marks, which a hover trades for its actions
     (.trow-act, index.css — CSS, so a hover re-renders nothing). */
  const fileEnd = (path: string, st: string | undefined) => (
    <>
      <span className="trow-mark" style={{ flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
        {path === live ? <>{pulse}<span style={{ fontSize: "var(--t95)", color: "var(--ok)" }}>editing</span></>
          : mine.has(path) && <span title="edited this session" style={{ display: "flex", color: "var(--acc)" }}><Sparkle size={10} strokeWidth={2} /></span>}
        {st && <span style={{ fontSize: "var(--t95)", fontWeight: 700, color: ST_COLOR(st) }}>{st}</span>}
      </span>
      <span className="trow-act">
        {onAddToPrompt && (
          <span role="button" title="Add to prompt" onClick={(e) => { e.stopPropagation(); onAddToPrompt(path); }}><AtSign size={13} strokeWidth={2} /></span>
        )}
        <span role="button" title="Copy path" onClick={(e) => { e.stopPropagation(); copyPath(path); }}><Copy size={12} strokeWidth={2} /></span>
      </span>
    </>
  );

  function onFindKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();   // App's Escape would close whatever sits on top
      if (q) setQ(""); else e.currentTarget.blur();
    } else if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, found.hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      const h = found.hits[sel];
      if (h) onOpenFile(h.path, changed.has(h.path));
    }
  }

  const qlen = q.trim().length;
  const results = (
    <div className="swapin">
      <div style={{ display: "flex", gap: 8, padding: "2px 9px 6px", fontSize: "var(--t9)", letterSpacing: ".4px", color: "var(--txd)" }}>
        <span>{found.total ? `${found.total} file${found.total === 1 ? "" : "s"}` : "No file matches."}</span>
        <span style={{ flex: 1 }} />
        {found.total > 0 && <span>↵ open · esc clear</span>}
      </div>
      {found.hits.map((h, i) => {
        const st = changed.get(h.path);
        return (
          <button key={h.path} className="trow" data-sel={i === sel ? "" : undefined}
            onClick={() => onOpenFile(h.path, !!st)} onMouseMove={() => { if (i !== sel) setSel(i); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, path: h.path, dir: false }); }}
            title={isIgnored(h.path) ? `${h.path} — git-ignored` : h.path}
            style={{ width: "100%", appearance: "none", border: 0, cursor: "pointer", opacity: isIgnored(h.path) ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6, textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)", height: 24, padding: "0 9px",
              background: i === sel ? "color-mix(in srgb, var(--acc) 14%, transparent)" : undefined }}>
            <FileIcon name={h.name} size={15} />
            <span style={{ color: st ? ST_COLOR(st) : "var(--txm)", flex: "none", maxWidth: "62%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {h.at < 0 ? h.name : (
                <>{h.name.slice(0, h.at)}<b style={{ color: "var(--txb)", fontWeight: 700, textDecoration: "underline", textDecorationColor: "color-mix(in srgb, var(--acc) 70%, transparent)", textUnderlineOffset: 3 }}>{h.name.slice(h.at, h.at + qlen)}</b>{h.name.slice(h.at + qlen)}</>
              )}
            </span>
            <span style={{ flex: 1, minWidth: 0, textAlign: "right", color: "var(--txd)", fontSize: "var(--t95)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.dir}</span>
            {fileEnd(h.path, st)}
          </button>
        );
      })}
      {found.total > found.hits.length && (
        <div style={{ padding: "8px 9px", fontSize: "var(--t95)", color: "var(--txd)" }}>{found.total - found.hits.length} more: keep typing</div>
      )}
    </div>
  );

  return (
    <div className="panel gp" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* GIT's head (.gp root + gp-*), so the two tabs read alike in every theme. */}
      <div className="gp-head">
        <span className="gp-title">FILES</span>
        {branch && <span className="gp-branch" title={branch}><i>⎇</i><span>{branch}</span></span>}
        {tools.map((t) => (
          <button key={t.k} className="gp-ib" onClick={t.on} title={t.t} aria-label={t.t}>{t.g}</button>
        ))}
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)", flex: "none" }} />

      {project && (
        // The sidebar's search, so every theme family draws it the same way.
        <div className="sess-search" style={{ display: "flex", alignItems: "center", gap: 10, height: 34, margin: "6px 12px 2px", flex: "none",
                      borderBottom: "1px solid color-mix(in srgb, var(--acc) 9%, transparent)" }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flex: "none" }} aria-hidden="true">
            <circle cx="5" cy="5" r="3.6" stroke="var(--txl)" strokeWidth="1.3" />
            <line x1="7.8" y1="7.8" x2="11" y2="11" stroke="var(--txl)" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input ref={findRef} value={q} placeholder="Find a file" aria-label="find a file" spellCheck={false}
            onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onFindKey}
            style={{ flex: 1, minWidth: 0, height: "100%", border: 0, outline: "none", background: "transparent", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", color: "var(--txb)" }} />
          <span title="⌘P / Ctrl+P jumps here from anywhere" style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txl)" }}>⌘P</span>
        </div>
      )}

      {/* The panel fills the rail; only this list scrolls — the tab is marked
          ownScroll so the rail wrapper doesn't add a second scrollbar. */}
      <div ref={listRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}
        className="mscroll" style={{ padding: "6px 4px 9px", flex: 1, minHeight: 0 }}>
        {note && (
          <div onClick={() => setNote("")} title="dismiss"
            style={{ cursor: "pointer", margin: "0 8px 6px", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", color: "var(--txl)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{note}</div>
        )}
        {!project && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 9px" }}>No session selected.</div>}
        {project && !finding && !rows.length && (
          skel ? (
            <div className="swapin" style={{ padding: "4px 7px" }} aria-label="Reading the working tree" aria-busy>
              {SKEL.map(([d, w], i) => (
                <Skeleton key={i} className="h-[13px] rounded-none"
                  style={{
                    marginLeft: 9 + d * IND,
                    width: `${w}%`, marginBottom: 11,   // 13 + 11: a row's 24px
                    background: "color-mix(in srgb, var(--acc) 13%, transparent)",
                  }} />
              ))}
            </div>
          ) : treeReady ? (
            <div className="swapin" style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 9px" }}>
              No files — not a git repo?
            </div>
          ) : null
        )}
        {/* vskip-row: a repo tree is thousands of rows once expanded — off-screen
            ones skip layout and paint (see index.css). */}
        {finding ? results : (
        <div className="vskip-row swapin">
        {rows.map((r) => {
          const st = r.dir ? undefined : changed.get(r.path);
          const open = r.dir && !collapsed.has(r.path);
          const nMine = r.dir && !open ? mineDirs.get(r.path) : undefined;
          const nChg = r.dir ? changedDirs.get(r.path) : undefined;
          return (
            <button key={r.key} className="trow" onClick={() => (r.dir ? toggleDir(r.path) : onOpenFile(r.path, !!st))}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();   // the dashboard's own right-click menu listens on window
                setCtx({ x: e.clientX, y: e.clientY, path: r.path, dir: r.dir });
              }}
              title={isIgnored(r.path) ? `${r.path} — git-ignored` : r.path}
              style={{ position: "relative", width: "100%", appearance: "none", border: 0, cursor: "pointer", opacity: isIgnored(r.path) ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6, textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)", height: 24, padding: "0 8px 0 0", paddingLeft: 7 + r.depth * IND,
                background: r.path === live ? LIVE_BG : undefined }}>
              {Array.from({ length: r.depth }, (_, i) => (
                <span key={i} aria-hidden style={{ position: "absolute", left: 12 + i * IND, top: 0, bottom: 0, width: 1, background: "color-mix(in srgb, var(--txl) 18%, transparent)" }} />
              ))}
              {r.dir ? (
                <>
                  <ChevronRight size={12} strokeWidth={2.4} style={{ flex: "none", color: "var(--txl)", transform: open ? "rotate(90deg)" : undefined }} />
                  {open ? <FolderOpen size={15} strokeWidth={1.8} style={{ flex: "none", color: "var(--txm)" }} />
                    : <Folder size={15} strokeWidth={1.8} style={{ flex: "none", color: "var(--txd)" }} />}
                  <span style={{ color: "var(--txh)", fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  {/* An open folder's files carry their own marks; a closed one counts them. */}
                  {open ? (nChg ? <span style={{ flex: "none", width: 5, height: 5, borderRadius: "50%", background: "var(--warn)", opacity: 0.7 }} /> : null) : (
                    <>
                      {liveDirs.has(r.path) && pulse}
                      {!!nMine && (
                        <span title={`${nMine} edited this session`} style={{ flex: "none", display: "flex", alignItems: "center", gap: 3, fontSize: "var(--t9)", color: "var(--acc)" }}>
                          <Sparkle size={10} strokeWidth={2} />{nMine}
                        </span>
                      )}
                      {!!nChg && (
                        <span title={`${nChg} with uncommitted changes`} style={{ flex: "none", display: "flex", alignItems: "center", gap: 4, fontSize: "var(--t9)", color: "var(--warn)" }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--warn)" }} />{nChg}
                        </span>
                      )}
                    </>
                  )}
                </>
              ) : (
                <>
                  <span style={{ width: 12, flex: "none" }} />
                  <FileIcon name={r.name} size={15} />
                  <span style={{ color: st ? ST_COLOR(st) : "var(--txm)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  {fileEnd(r.path, st)}
                </>
              )}
            </button>
          );
        })}
        </div>
        )}
      </div>

      {scrolled && (
        <button onClick={() => listRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
          title="back to top" aria-label="back to top"
          style={{ position: "absolute", right: 14, bottom: 12, zIndex: 4, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--panel2) 94%, transparent)", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.2, padding: "4px 9px" }}>↑ TOP</button>
      )}

      {ctx && (
        <ContextMenu ctx={{ x: ctx.x, y: ctx.y, type: ctx.dir ? "folder" : "file", id: ctx.path, label: ctx.path }}
          items={ctxItems(ctx)} onClose={() => setCtx(null)} />
      )}
    </div>
  );
}
