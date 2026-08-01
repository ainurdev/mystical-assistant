import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { buildRows, dirsOf, iconColor } from "./EditorTab";

/* FILES — a VS Code-ish explorer for the ACTIVE SESSION's working tree
   (project + its branch's worktree). Git-changed files carry their status
   letter and colour, and every folder above one gets a dot, so a change is
   findable without expanding the whole tree. Clicking a file hands it to the
   editor modal. Tree building is shared with the EDITOR tab. */

interface Props {
  project: string | null;
  branch?: string;
  // CHANGES mode: skip the tree entirely and list only git-changed files, flat
  // and full-path. Same panel, same polling — just the other half of the data.
  changedOnly?: boolean;
  // `changed` lets the caller land a dirty file on the GIT tab (diff) instead
  // of the editor, so its changed lines are visible.
  onOpenFile: (path: string, changed: boolean) => void;
}

const ST_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");

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
  const [changed, setChanged] = useState<Map<string, string>>(new Map());
  // Folders start closed — a repo tree is thousands of rows in a 358px column.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hov, setHov] = useState("");
  const [loading, setLoading] = useState(false);
  // CHANGES mode also owns commit/push (the git panel is graph-only).
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // The commit box rides at the top of the list, so a long list scrolls it out
  // of reach — hence the back-to-top button.
  const listRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  const loadTree = useCallback(async () => {
    if (!project || changedOnly) { setPaths([]); return; }
    setLoading(true);
    try {
      const r = await api.filesTree(project, branch || undefined);
      setPaths(r.files);
      setCollapsed(new Set(dirsOf(r.files)));
    } catch { setPaths([]); }
    finally { setLoading(false); }
  }, [project, branch, changedOnly]);

  useEffect(() => { void loadTree(); }, [loadTree]);

  const loadGit = useCallback(async () => {
    if (!project) { setChanged(new Map()); return; }
    try {
      const g = await api.git(project, branch || undefined);
      setChanged(new Map(g.files.map((f) => [f.path, f.status])));
    } catch { setChanged(new Map()); }
  }, [project, branch]);

  // Working-tree status, refreshed on the same cadence as the git badges.
  useEffect(() => {
    void loadGit();
    const id = setInterval(() => void loadGit(), 10000);
    return () => clearInterval(id);
  }, [loadGit]);

  // CHANGES mode lists the git files flat, showing the full path (a basename
  // alone is useless once the tree around it is gone).
  const rows = useMemo(
    () =>
      changedOnly
        ? [...changed.keys()].sort((a, b) => a.localeCompare(b))
            .map((p) => ({ key: `f:${p}`, dir: false, depth: 0, name: p, path: p }))
        : buildRows(paths, collapsed),
    [changedOnly, changed, paths, collapsed],
  );
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
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "var(--txl)" }}>{changedOnly ? "CHANGES" : "FILES"}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {changed.size > 0 && (
            <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--warn)" }}>{changed.size} CHANGED</span>
          )}
          {tools.map((t) => (
            <button key={t.k} onClick={t.on} title={t.t}
              onMouseEnter={() => setHov(t.k)} onMouseLeave={() => setHov("")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === t.k ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 9.5, lineHeight: 1.3, padding: "2px 6px" }}>{t.g}</button>
          ))}
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />

      {branch && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px 0", fontSize: 9, color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", minWidth: 0 }}>
          <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{branch}</span>
        </div>
      )}

      {/* The panel fills the rail; only this list scrolls — the tab is marked
          ownScroll so the rail wrapper doesn't add a second scrollbar. */}
      <div ref={listRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}
        className="mscroll" style={{ padding: "6px 4px 9px", flex: 1, minHeight: 0 }}>
        {changedOnly && project && (
          <div style={{ borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "3px 8px 9px", marginBottom: 6 }}>
            <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} placeholder="Commit message…"
              style={{ width: "100%", resize: "none", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "transparent", color: "var(--txf)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, lineHeight: 1.5, padding: "6px 7px", outline: "none" }} />
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {[
                { k: "cm", l: "COMMIT ALL", on: () => void commit(), off: busy || !msg.trim() || !changed.size, grow: 1 },
                { k: "ps", l: "PUSH", on: () => void push(), off: busy, grow: 0 },
              ].map((b) => (
                <button key={b.k} onClick={b.on} disabled={b.off}
                  onMouseEnter={() => setHov(b.k)} onMouseLeave={() => setHov("")}
                  style={{ flex: b.grow ? 1 : "none", appearance: "none", cursor: b.off ? "not-allowed" : "pointer", opacity: b.off ? 0.4 : 1, border: "1px solid color-mix(in srgb, var(--acc) 24%, transparent)", background: hov === b.k && !b.off ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.2, padding: "5px 10px" }}>{b.l}</button>
              ))}
            </div>
            {note && (
              <div style={{ marginTop: 6, fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, color: "var(--txl)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{note}</div>
            )}
          </div>
        )}
        {!project && <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "8px 9px" }}>No session selected.</div>}
        {project && !rows.length && (
          <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "8px 9px" }}>
            {changedOnly ? "Working tree clean." : loading ? "Reading tree…" : "No files — not a git repo?"}
          </div>
        )}
        {rows.map((r) => {
          const st = r.dir ? undefined : changed.get(r.path);
          const marked = r.dir ? changedDirs.has(r.path) : !!st;
          const on = hov === r.key;
          return (
            <button key={r.key} onClick={() => (r.dir ? toggleDir(r.path) : onOpenFile(r.path, !!st))}
              onMouseEnter={() => setHov(r.key)} onMouseLeave={() => setHov("")}
              title={r.path}
              style={{ width: "100%", appearance: "none", border: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", background: on ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent", fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, padding: "3px 7px", paddingLeft: 7 + r.depth * 11 }}>
              {r.dir ? (
                <>
                  <span style={{ fontSize: 8, color: "var(--txd)", width: 9, flex: "none", textAlign: "center" }}>{collapsed.has(r.path) ? "▸" : "▾"}</span>
                  <span style={{ color: marked ? "var(--warn)" : "var(--txm)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  {marked && <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--warn)", flex: "none" }} />}
                </>
              ) : (
                <>
                  <span style={{ width: 9, flex: "none" }} />
                  <span style={{ width: 5, height: 5, flex: "none", background: iconColor(r.name), transform: "rotate(45deg)" }} />
                  {/* Full paths truncate from the left, so the filename survives. */}
                  <span style={{ color: st ? ST_COLOR(st) : "var(--txf)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: changedOnly ? "rtl" : "ltr", textAlign: "left" }}>{r.name}</span>
                  {st && <span style={{ fontSize: 9.5, fontWeight: 700, color: ST_COLOR(st), flex: "none" }}>{st}</span>}
                </>
              )}
            </button>
          );
        })}
      </div>

      {scrolled && (
        <button onClick={() => listRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
          title={changedOnly ? "back to top — commit box" : "back to top"} aria-label="back to top"
          style={{ position: "absolute", right: 14, bottom: 12, zIndex: 4, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--panel2) 94%, transparent)", color: "var(--txm)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1.2, padding: "4px 9px" }}>↑ TOP</button>
      )}
    </div>
  );
}
