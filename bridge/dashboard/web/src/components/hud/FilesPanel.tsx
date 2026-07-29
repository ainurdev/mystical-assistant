import { useCallback, useEffect, useMemo, useState } from "react";
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
  onOpenFile: (path: string) => void;
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

export function FilesPanel({ project, branch, onOpenFile }: Props) {
  const [paths, setPaths] = useState<string[]>([]);
  const [changed, setChanged] = useState<Map<string, string>>(new Map());
  // Folders start closed — a repo tree is thousands of rows in a 358px column.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hov, setHov] = useState("");
  const [loading, setLoading] = useState(false);

  const loadTree = useCallback(async () => {
    if (!project) { setPaths([]); return; }
    setLoading(true);
    try {
      const r = await api.filesTree(project, branch || undefined);
      setPaths(r.files);
      setCollapsed(new Set(dirsOf(r.files)));
    } catch { setPaths([]); }
    finally { setLoading(false); }
  }, [project, branch]);

  useEffect(() => { void loadTree(); }, [loadTree]);

  // Working-tree status, refreshed on the same cadence as the git badges.
  useEffect(() => {
    if (!project) { setChanged(new Map()); return; }
    let live = true;
    const tick = () =>
      void api.git(project, branch || undefined)
        .then((g) => { if (live) setChanged(new Map(g.files.map((f) => [f.path, f.status]))); })
        .catch(() => { if (live) setChanged(new Map()); });
    tick();
    const id = setInterval(tick, 10000);
    return () => { live = false; clearInterval(id); };
  }, [project, branch]);

  const rows = useMemo(() => buildRows(paths, collapsed), [paths, collapsed]);
  const changedDirs = useMemo(() => ancestorsOf(changed.keys()), [changed]);
  const dirs = useMemo(() => dirsOf(paths), [paths]);
  const allCollapsed = dirs.length > 0 && collapsed.size >= dirs.length;

  const toggleDir = (p: string) =>
    setCollapsed((c) => { const n = new Set(c); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  // Expand only what's needed to show every changed file.
  const revealChanges = () =>
    setCollapsed((c) => { const n = new Set(c); for (const d of changedDirs) n.delete(d); return n; });

  const tools: { k: string; g: string; t: string; on: () => void }[] = [
    { k: "chg", g: "◈", t: "reveal changed files", on: revealChanges },
    { k: "col", g: allCollapsed ? "⊞" : "⊟", t: allCollapsed ? "expand all" : "collapse all",
      on: () => setCollapsed(allCollapsed ? new Set() : new Set(dirs)) },
    { k: "ref", g: "⟳", t: "refresh", on: () => void loadTree() },
  ];

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", animation: "enterRight .55s cubic-bezier(.2,.8,.2,1) both .18s", flex: "none" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "var(--txl)" }}>FILES</span>
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

      <div className="mscroll" style={{ padding: "6px 4px 9px", maxHeight: "min(72vh, 760px)", overflowY: "auto" }}>
        {!project && <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "8px 9px" }}>No session selected.</div>}
        {project && !rows.length && (
          <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "8px 9px" }}>
            {loading ? "Reading tree…" : "No files — not a git repo?"}
          </div>
        )}
        {rows.map((r) => {
          const st = r.dir ? undefined : changed.get(r.path);
          const marked = r.dir ? changedDirs.has(r.path) : !!st;
          const on = hov === r.key;
          return (
            <button key={r.key} onClick={() => (r.dir ? toggleDir(r.path) : onOpenFile(r.path))}
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
                  <span style={{ color: st ? ST_COLOR(st) : "var(--txf)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  {st && <span style={{ fontSize: 9.5, fontWeight: 700, color: ST_COLOR(st), flex: "none" }}>{st}</span>}
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
