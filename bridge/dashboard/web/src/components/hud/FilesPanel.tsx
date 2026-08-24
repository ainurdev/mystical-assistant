import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type GitFile } from "../../api";
import { buildRows, dirsOf } from "./EditorTab";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { askConfirm } from "../ui/Ask";
import { FileIcon } from "../../lib/fileicon";
import { ignoredMatcher } from "../../lib/gitignored";
import { Skeleton } from "../ui";
import { useLoadingPhase } from "../../lib/loadingPhase";

/* FILES — a VS Code-ish explorer for the ACTIVE SESSION's working tree
   (project + its branch's worktree). Git-changed files carry their status
   letter and colour, and every folder above one gets a dot, so a change is
   findable without expanding the whole tree. Clicking a file hands it to the
   editor modal. Tree building is shared with the EDITOR tab. */

interface Props {
  project: string | null;
  branch?: string;
  // CHANGES mode: skip the tree entirely and list only git-changed files, flat
  // and full-path, split into STAGED CHANGES and CHANGES the way VS Code's
  // source-control view does. Same panel, same polling — the other half of the
  // data. A partially-staged file is in both lists, because it really is.
  changedOnly?: boolean;
  // `changed` lets the caller land a dirty file on the GIT tab (diff) instead
  // of the editor, so its changed lines are visible.
  onOpenFile: (path: string, changed: boolean) => void;
}

/* A tree row, or — in CHANGES mode — a section header (`head`) or one of its
   files, tagged with the half it belongs to. */
type Row = {
  key: string; dir: boolean; depth: number; name: string; path: string;
  head?: boolean; staged?: boolean; st?: string;
};

const ST_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");

/* Placeholder rows while the list loads: [indent, width%]. Shaped like a tree
   rather than a spinner, so the panel's layout is already there when the real
   rows replace it and nothing jumps. */
const SKEL: [number, number][] = [
  [0, 62], [1, 78], [1, 51], [0, 70], [1, 44], [1, 83], [0, 57], [1, 66], [1, 38], [0, 74], [1, 60], [1, 47],
];

function ancestorsOf(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      out.add(prefix);
    }
  }
  return out;
}

export function FilesPanel({ project, branch, changedOnly, onOpenFile }: Props) {
  const [paths, setPaths] = useState<string[]>([]);
  // .gitignore'd paths, as prefixes — listed like everything else, just dimmed.
  const [ignored, setIgnored] = useState<string[]>([]);
  const [files, setFiles] = useState<GitFile[]>([]);
  // Folders start closed — a repo tree is thousands of rows in a 358px column.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hov, setHov] = useState("");
  // Has the fetch that fills THIS mode come back yet? An empty list before the
  // first answer means "not read yet", not "nothing here" — the tree read is
  // ~1s on a big repo, and the panel used to spend it claiming the project was
  // not a git repo, because [] renders the same either way.
  const [treeReady, setTreeReady] = useState(false);
  const [gitReady, setGitReady] = useState(false);
  // CHANGES mode also owns commit/push (the git panel is graph-only).
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [gen, setGen] = useState(false);
  const [note, setNote] = useState("");
  // Right-clicked row. `staged` says which half it was clicked in, which is
  // what decides between Stage and Unstage.
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; dir: boolean; staged: boolean } | null>(null);
  // The commit box rides at the top of the list, so a long list scrolls it out
  // of reach — hence the back-to-top button.
  const listRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  const loadTree = useCallback(async () => {
    if (!project || changedOnly) { setPaths([]); return; }
    try {
      const r = await api.filesTree(project, branch || undefined);
      setPaths(r.files);
      setIgnored(r.ignored ?? []);
      setCollapsed(new Set(dirsOf(r.files)));
    } catch { setPaths([]); setIgnored([]); }
    finally { setTreeReady(true); }
  }, [project, branch, changedOnly]);

  useEffect(() => { void loadTree(); }, [loadTree]);

  const loadGit = useCallback(async () => {
    if (!project) { setFiles([]); return; }
    try {
      const g = await api.git(project, branch || undefined);
      setFiles(g.files);
    } catch { setFiles([]); }
    finally { setGitReady(true); }
  }, [project, branch]);

  const changed = useMemo(
    () => new Map(files.map((f) => [f.path, f.status])), [files]);
  // A file is staged when the index half of porcelain's pair moved, and
  // unstaged when the working-tree half did. An old backend sends neither, so
  // everything reads as unstaged — which is exactly how this panel used to be.
  const staged = useMemo(
    () => files.filter((f) => (f.x ?? ".") !== "." && f.x !== "?")
      .sort((a, b) => a.path.localeCompare(b.path)), [files]);
  const unstaged = useMemo(
    () => files.filter((f) => (f.y ?? "M") !== ".")
      .sort((a, b) => a.path.localeCompare(b.path)), [files]);

  // Working-tree status, refreshed on the same cadence as the git badges.
  useEffect(() => {
    void loadGit();
    const id = setInterval(() => void loadGit(), 10000);
    return () => clearInterval(id);
  }, [loadGit]);

  // CHANGES mode lists the git files flat, showing the full path (a basename
  // alone is useless once the tree around it is gone), under a header per
  // section. `st` is the letter for the half the row is in — a file staged as
  // added and then edited is A here and M below, and saying "M" in both would
  // be a lie about what's about to be committed.
  const rows: Row[] = useMemo(() => {
    if (!changedOnly) return buildRows(paths, collapsed);
    const section = (title: string, list: GitFile[], sec: boolean): Row[] =>
      list.length
        ? [
          { key: `h:${title}`, dir: false, depth: 0, name: title, path: "", head: true, staged: sec },
          ...list.map((f) => ({
            key: `${sec ? "s" : "u"}:${f.path}`, dir: false, depth: 0,
            name: f.path, path: f.path, staged: sec, st: (sec ? f.x : f.y) || f.status,
          })),
        ]
        : [];
    return [...section("STAGED CHANGES", staged, true), ...section("CHANGES", unstaged, false)];
  }, [changedOnly, staged, unstaged, paths, collapsed]);
  const isIgnored = useMemo(() => ignoredMatcher(ignored), [ignored]);
  const changedDirs = useMemo(() => ancestorsOf(changed.keys()), [changed]);
  const dirs = useMemo(() => dirsOf(paths), [paths]);
  const allCollapsed = dirs.length > 0 && collapsed.size >= dirs.length;

  const toggleDir = (p: string) =>
    setCollapsed((c) => { const n = new Set(c); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  // Expand only what's needed to show every changed file.
  const revealChanges = () =>
    setCollapsed((c) => { const n = new Set(c); for (const d of changedDirs) n.delete(d); return n; });

  async function commit() {
    if (!project || !msg.trim()) return;
    setBusy(true);
    try {
      const r = await api.gitCommit(project, msg.trim(), undefined, branch || undefined);
      setNote(r.ok ? "Committed." : r.output || "Commit failed.");
      if (r.ok) { setMsg(""); void loadGit(); }
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  }

  async function push() {
    if (!project) return;
    setBusy(true);
    try {
      const r = await api.gitPush(project, branch || undefined);
      setNote(r.ok ? "Pushed." : r.output || "Push failed.");
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  }

  /** Generate the commit message from what's about to be committed — the
   *  staged set once anything is staged, since that's what COMMIT will take. */
  async function generate() {
    const paths = (staged.length ? staged : unstaged).map((f) => f.path);
    if (!project || !paths.length) return;
    setGen(true);
    setNote("");
    try {
      const r = await api.commitMessage(project, branch || "", paths);
      if (r.message) setMsg(r.message);
      else setNote(r.error || "Couldn't write a message.");
    } catch (e) { setNote((e as Error).message); }
    finally { setGen(false); }
  }

  async function gitOp(op: "stage" | "unstage" | "discard", paths: string[]) {
    if (!project || !paths.length) return;
    setBusy(true);
    try {
      const r = await api.gitOp(project, op, paths, branch || undefined);
      setNote(r.ok ? "" : r.output || `${op} failed.`);
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); void loadGit(); }
  }

  async function del(path: string) {
    if (!project) return;
    try {
      const r = await api.fileOp(project, "delete", path, undefined, branch || undefined);
      setNote(r.ok ? "" : r.error || "Delete failed.");
    } catch (e) { setNote((e as Error).message); }
    void loadGit();
    if (!changedOnly) void loadTree();
  }

  const copyPath = (p: string) => {
    try { void navigator.clipboard?.writeText(p); setNote(`Copied ${p}`); } catch { /* ignore */ }
  };

  /* Row menu. What's offered follows the half the row was clicked in: a staged
     row can only be unstaged (discarding it would throw away work the index is
     already holding), an unstaged one can be staged or discarded. */
  function ctxItems(t: NonNullable<typeof ctx>): CtxItem[] {
    if (t.dir) return [{ icon: "⧉", label: "Copy Path", onClick: () => copyPath(t.path) }];
    const st = changed.get(t.path);
    const untracked = st === "?";
    const items: CtxItem[] = [
      { icon: "▤", label: "Open File", onClick: () => onOpenFile(t.path, false) },
    ];
    if (st) items.push({ icon: "◫", label: "Open Changes", hint: "diff", onClick: () => onOpenFile(t.path, true) });
    if (st) {
      items.push({ divider: true });
      if (t.staged) {
        items.push({ icon: "−", label: "Unstage Changes", onClick: () => void gitOp("unstage", [t.path]) });
      } else {
        items.push({ icon: "+", label: "Stage Changes", onClick: () => void gitOp("stage", [t.path]) });
        items.push({
          icon: "↺", label: "Discard Changes", danger: true,
          hint: untracked ? "never committed — this deletes it" : undefined,
          onClick: () => void askConfirm(untracked
            ? `Delete ${t.path}? It was never committed, so there is nothing to restore.`
            : `Discard your changes to ${t.path}? This can't be undone.`)
            .then((yes) => { if (yes) void gitOp("discard", [t.path]); }),
        });
      }
    }
    items.push({ divider: true });
    items.push({ icon: "⧉", label: "Copy Path", onClick: () => copyPath(t.path) });
    items.push({
      icon: "✕", label: "Delete File", danger: true,
      onClick: () => void askConfirm(`Delete ${t.path} from disk?`)
        .then((yes) => { if (yes) void del(t.path); }),
    });
    if (changedOnly && (staged.length || unstaged.length)) {
      items.push({ divider: true });
      if (unstaged.length)
        items.push({ icon: "+", label: `Stage All Changes (${unstaged.length})`,
          onClick: () => void gitOp("stage", unstaged.map((f) => f.path)) });
      if (staged.length)
        items.push({ icon: "−", label: `Unstage All (${staged.length})`,
          onClick: () => void gitOp("unstage", staged.map((f) => f.path)) });
      if (unstaged.length)
        items.push({
          icon: "↺", label: `Discard All Changes (${unstaged.length})`, danger: true,
          onClick: () => void askConfirm(`Discard every unstaged change in this working tree (${unstaged.length} file${unstaged.length === 1 ? "" : "s"})? This can't be undone.`)
            .then((yes) => { if (yes) void gitOp("discard", unstaged.map((f) => f.path)); }),
        });
    }
    return items;
  }

  const noCommit = busy || !msg.trim() || !changed.size;
  // FILES waits on the tree read, CHANGES on the git poll. useLoadingPhase keeps
  // a fast answer (a cached tree, a clean `git status`) from strobing the
  // placeholder on and off inside one frame budget.
  const ready = changedOnly ? gitReady : treeReady;
  const skel = useLoadingPhase(!ready);

  const tools: { k: string; g: string; t: string; on: () => void }[] = changedOnly
    ? [{ k: "ref", g: "⟳", t: "refresh", on: () => void loadGit() }]
    : [
      { k: "chg", g: "◈", t: "reveal changed files", on: revealChanges },
      { k: "col", g: allCollapsed ? "⊞" : "⊟", t: allCollapsed ? "expand all" : "collapse all",
        on: () => setCollapsed(allCollapsed ? new Set() : new Set(dirs)) },
      { k: "ref", g: "⟳", t: "refresh", on: () => void loadTree() },
    ];

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>{changedOnly ? "CHANGES" : "FILES"}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {changed.size > 0 && (
            <span style={{ fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--warn)" }}>{changed.size} CHANGED</span>
          )}
          {tools.map((t) => (
            <button key={t.k} onClick={t.on} title={t.t}
              onMouseEnter={() => setHov(t.k)} onMouseLeave={() => setHov("")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === t.k ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px" }}>{t.g}</button>
          ))}
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />

      {branch && (
        <div className="swapin" style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px 0", fontSize: "var(--t9)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", minWidth: 0 }}>
          <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch}</span>
        </div>
      )}

      {/* The panel fills the rail; only this list scrolls — the tab is marked
          ownScroll so the rail wrapper doesn't add a second scrollbar. */}
      <div ref={listRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}
        className="mscroll" style={{ padding: "6px 4px 9px", flex: 1, minHeight: 0 }}>
        {changedOnly && project && (
          <div className="cbox" style={{ borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "3px 8px 9px", marginBottom: 6 }}>
            <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} placeholder="Commit message…"
              title="⌘/Ctrl+Enter to commit"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && msg.trim() && changed.size && !busy) { e.preventDefault(); void commit(); }
              }}
              style={{ width: "100%", resize: "none", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--acc) 3%, transparent)", color: "var(--tx)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", lineHeight: 1.5, padding: "6px 7px", outline: "none" }} />
            {/* Two rows, because three labels never fit the rail's width — the
                message helpers sit under the box they write into, and COMMIT
                gets the full width as the panel's one primary action. */}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {[
                { k: "gen", l: gen ? "WRITING…" : "✧ GENERATE", t: "write the message from the diff",
                  on: () => void generate(), off: gen || busy || !changed.size, grow: 1 },
                { k: "ps", l: "↑ PUSH", t: "push to the remote", on: () => void push(), off: busy, grow: 0 },
              ].map((b) => (
                <button key={b.k} onClick={b.on} disabled={b.off} title={b.t}
                  onMouseEnter={() => setHov(b.k)} onMouseLeave={() => setHov("")}
                  style={{ flex: b.grow ? 1 : "none", appearance: "none", whiteSpace: "nowrap", cursor: b.off ? "not-allowed" : "pointer", opacity: b.off ? 0.4 : 1, border: "1px solid color-mix(in srgb, var(--acc) 24%, transparent)", background: hov === b.k && !b.off ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.2, padding: "5px 10px" }}>{b.l}</button>
              ))}
            </div>
            {/* The label is the promise: with an index, COMMIT takes only
                what's in it (bridge/git.py commit()), so saying "ALL" would
                be wrong the moment you stage one file. */}
            <button onClick={() => void commit()} disabled={noCommit} title="⌘/Ctrl+Enter"
              onMouseEnter={() => setHov("cm")} onMouseLeave={() => setHov("")}
              style={{ width: "100%", marginTop: 6, appearance: "none", whiteSpace: "nowrap", cursor: noCommit ? "not-allowed" : "pointer", opacity: noCommit ? 0.4 : 1, border: "1px solid var(--acc)", background: hov === "cm" && !noCommit ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "6px 10px" }}>
              {!ready ? "▸ COMMIT" : staged.length ? `▸ COMMIT STAGED (${staged.length})` : `▸ COMMIT ALL (${changed.size})`}
            </button>
          </div>
        )}
        {note && (
          <div onClick={() => setNote("")} title="dismiss"
            style={{ cursor: "pointer", margin: "0 8px 6px", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", color: "var(--txl)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{note}</div>
        )}
        {!project && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 9px" }}>No session selected.</div>}
        {project && !rows.length && (
          skel ? (
            <div className="swapin" style={{ padding: "4px 7px" }} aria-label="Reading the working tree" aria-busy>
              {SKEL.map(([d, w], i) => (
                <Skeleton key={i} className="h-[13px] rounded-none"
                  style={{
                    // CHANGES lists flat full paths — indenting its placeholder
                    // would promise a tree that never arrives.
                    marginLeft: 9 + (changedOnly ? 0 : d * 11),
                    width: `${w}%`, marginBottom: 5,
                    background: "color-mix(in srgb, var(--acc) 13%, transparent)",
                  }} />
              ))}
            </div>
          ) : ready ? (
            <div className="swapin" style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 9px" }}>
              {changedOnly ? "Working tree clean." : "No files — not a git repo?"}
            </div>
          ) : null
        )}
        {/* vskip-row: a repo tree is thousands of rows once expanded — off-screen
            ones skip layout and paint (see index.css). */}
        <div className="vskip-row swapin">
        {rows.map((r) => {
          if (r.head) {
            const list = r.staged ? staged : unstaged;
            return (
              <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 7px 3px" }}>
                <span style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", flex: 1 }}>{r.name}</span>
                <span style={{ fontSize: "var(--t85)", color: "var(--txd)" }}>{list.length}</span>
                <button onClick={() => void gitOp(r.staged ? "unstage" : "stage", list.map((f) => f.path))}
                  disabled={busy} title={r.staged ? "unstage all" : "stage all"}
                  style={{ appearance: "none", cursor: busy ? "not-allowed" : "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", lineHeight: 1.2, padding: "0 6px" }}>{r.staged ? "−" : "+"}</button>
              </div>
            );
          }
          // In CHANGES the row already knows its half's letter; in FILES it's
          // the merged status off the git poll.
          const st = r.dir ? undefined : r.st ?? changed.get(r.path);
          const marked = r.dir ? changedDirs.has(r.path) : !!st;
          return (
            <button key={r.key} className="trow" onClick={() => (r.dir ? toggleDir(r.path) : onOpenFile(r.path, !!st))}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();   // the dashboard's own right-click menu listens on window
                setCtx({ x: e.clientX, y: e.clientY, path: r.path, dir: r.dir, staged: !!r.staged });
              }}
              title={isIgnored(r.path) ? `${r.path} — git-ignored` : r.path}
              style={{ width: "100%", appearance: "none", border: 0, cursor: "pointer", opacity: isIgnored(r.path) ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6, textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t105)", padding: "3px 7px", paddingLeft: 7 + r.depth * 11 }}>
              {r.dir ? (
                <>
                  <span style={{ fontSize: "var(--t8)", color: "var(--txd)", width: 9, flex: "none", textAlign: "center" }}>{collapsed.has(r.path) ? "▸" : "▾"}</span>
                  <span style={{ color: marked ? "var(--warn)" : "var(--txm)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  {marked && <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--warn)", flex: "none" }} />}
                </>
              ) : (
                <>
                  <span style={{ width: 9, flex: "none" }} />
                  <FileIcon name={r.name} size={13} />
                  {/* Full paths truncate from the left, so the filename survives. */}
                  <span style={{ color: st ? ST_COLOR(st) : "var(--txf)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: changedOnly ? "rtl" : "ltr", textAlign: "left" }}>{r.name}</span>
                  {st && <span style={{ fontSize: "var(--t95)", fontWeight: 700, color: ST_COLOR(st), flex: "none" }}>{st}</span>}
                </>
              )}
            </button>
          );
        })}
        </div>
      </div>

      {scrolled && (
        <button onClick={() => listRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
          title={changedOnly ? "back to top — commit box" : "back to top"} aria-label="back to top"
          style={{ position: "absolute", right: 14, bottom: 12, zIndex: 4, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--panel2) 94%, transparent)", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.2, padding: "4px 9px" }}>↑ TOP</button>
      )}

      {ctx && (
        <ContextMenu ctx={{ x: ctx.x, y: ctx.y, type: ctx.dir ? "folder" : "file", id: ctx.path, label: ctx.path }}
          items={ctxItems(ctx)} onClose={() => setCtx(null)} />
      )}
    </div>
  );
}
