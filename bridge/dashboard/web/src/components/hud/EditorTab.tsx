import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GitFile } from "../../api";

/* EDITOR tab of the Analyze modal — vim-style read-only viewer. The explorer
   shows the selected branch's modified files as a tree (there is no generic
   file-listing endpoint yet); the buffer renders that file's working-tree diff.
   Matches the HUD design mock (hud.dc.html lines 992–1062).
   TODO(phase2-data): full file tree + file contents + :w handling need backend
   endpoints that don't exist yet. */

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
  status?: string;
}

interface EvLine {
  n: string;
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

const FILE_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");

const EXT_COLOR: Record<string, string> = {
  ts: "var(--info)", tsx: "var(--info)", js: "var(--warn)", jsx: "var(--warn)", css: "var(--purple)", scss: "var(--purple)",
  md: "var(--txm)", json: "var(--warn)", py: "var(--ok)", html: "var(--err)",
};
function iconColor(name: string): string {
  const ext = name.split(".").pop() ?? "";
  return EXT_COLOR[ext] ?? "#7fa8a0";
}

function buildRows(files: GitFile[], collapsed: Set<string>): TreeRow[] {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  for (const f of sorted) {
    const parts = f.path.split("/");
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
    if (!hidden) rows.push({ key: `f:${f.path}`, dir: false, depth: parts.length - 1, name: parts[parts.length - 1] ?? f.path, path: f.path, status: f.status });
  }
  return rows;
}

/* Unified diff → vim-buffer lines: sequential numbers from each hunk's new-file
   start (matching the mock's numbering), headers before the first hunk dropped. */
function parseDiff(diff: string): EvLine[] {
  const out: EvLine[] = [];
  let n = 0;
  let inHunk = false;
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("@@")) {
      const m = /\+(\d+)/.exec(ln);
      if (m) n = parseInt(m[1], 10);
      inHunk = true;
      out.push({ n: "", kind: "hunk", text: ln });
      continue;
    }
    if (!inHunk) continue;
    if (ln.startsWith("+")) out.push({ n: String(n++), kind: "add", text: ln.slice(1) });
    else if (ln.startsWith("-")) out.push({ n: String(n++), kind: "del", text: ln.slice(1) });
    else out.push({ n: String(n++), kind: "ctx", text: ln.startsWith(" ") ? ln.slice(1) : ln });
  }
  return out;
}

const LINE_VIEW: Record<EvLine["kind"], { bg: string; c: string }> = {
  add: { bg: "color-mix(in srgb, var(--ok) 7%, transparent)", c: "#a7e6c3" },
  del: { bg: "color-mix(in srgb, var(--err) 7%, transparent)", c: "#f0b0a8" },
  hunk: { bg: "color-mix(in srgb, var(--acc) 6%, transparent)", c: "var(--acc)" },
  ctx: { bg: "transparent", c: "var(--txm)" },
};

export function EditorTab({ project, branch, branchOpts, onPickBranch }: Props) {
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [files, setFiles] = useState<GitFile[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [lines, setLines] = useState<EvLine[]>([]);
  const [mode, setMode] = useState<"NORMAL" | "INSERT">("NORMAL");
  const [cmd, setCmd] = useState("");
  const [note, setNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const noteT = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    setSel(null);
    setCollapsed(new Set());
    void api.git(project, branch || undefined)
      .then((g) => { if (live) setFiles(g.files); })
      .catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [project, branch]);

  const rows = useMemo(() => buildRows(files, collapsed), [files, collapsed]);
  const selPath = sel ?? files[0]?.path ?? null;

  useEffect(() => {
    if (!selPath) { setLines([]); return; }
    let live = true;
    void api.gitDiff(project, selPath, undefined, undefined, branch || undefined)
      .then((d) => { if (live) setLines(parseDiff(d.diff)); })
      .catch(() => { if (live) setLines([]); });
    return () => { live = false; };
  }, [selPath, project, branch]);

  useEffect(() => () => { if (noteT.current) clearTimeout(noteT.current); }, []);

  function onCmdKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    // TODO(phase2-data): no file-write endpoint yet — the buffer is read-only.
    setCmd("");
    setNote("E45: readonly");
    if (noteT.current) clearTimeout(noteT.current);
    noteT.current = setTimeout(() => setNote(""), 2500);
  }

  const lineCount = lines.filter((l) => l.kind !== "hunk").length;
  const tildes = Math.max(0, 20 - lines.length);

  return (
    <div style={{ animation: "mslide .3s ease both", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", flex: 1, minHeight: 430, overflow: "hidden" }}>
        {/* explorer */}
        <div style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", minHeight: 0, background: "color-mix(in srgb, var(--panel2) 35%, transparent)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px", flex: "none" }}>
            <span style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--txl)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>EXPLORER</span>
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
              <div style={{ fontSize: 11, color: "var(--txl)", padding: "8px 10px" }}>No modified files on ⎇ {branch || "this branch"}.</div>
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
              <button key={r.key} onClick={() => setSel(r.path)} title={r.path} {...hp(r.key)}
                style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${r.path === selPath ? "var(--acc)" : "transparent"}`, background: r.path === selPath ? "color-mix(in srgb, var(--acc) 8%, transparent)" : hov === r.key ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", paddingLeft: 8 + r.depth * 12 }}>
                <span style={{ width: 8, height: 10, flex: "none", background: iconColor(r.name), opacity: 0.85 }} />
                <span style={{ fontSize: 11, color: r.path === selPath ? "var(--txb)" : "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{r.name}</span>
                {r.status && <span style={{ fontSize: 9, fontWeight: 700, color: FILE_COLOR(r.status), flex: "none" }}>{r.status}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* buffer + vim chrome */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "color-mix(in srgb, var(--panel3) 50%, transparent)" }}>
          <div className="mscroll" style={{ flex: 1, overflow: "auto", minHeight: 0, fontFamily: "'JetBrains Mono',monospace", fontSize: 12, lineHeight: 1.65, padding: "6px 0" }}>
            {lines.map((l, i) => {
              const v = LINE_VIEW[l.kind];
              return (
                <div key={i} style={{ display: "flex", background: v.bg }}>
                  <span style={{ width: 38, flex: "none", textAlign: "right", paddingRight: 10, color: "var(--txg)", userSelect: "none" }}>{l.n}</span>
                  <span style={{ whiteSpace: "pre", paddingRight: 14 }}>
                    <span style={{ color: v.c }}>{l.text || " "}</span>
                  </span>
                </div>
              );
            })}
            {Array.from({ length: tildes }).map((_, i) => (
              <div key={`t${i}`} style={{ display: "flex" }}>
                <span style={{ width: 38, flex: "none", textAlign: "right", paddingRight: 10, color: "#243634", userSelect: "none" }}>~</span>
              </div>
            ))}
          </div>
          <div style={{ flex: "none", display: "flex", alignItems: "stretch", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5 }}>
            <span style={{ background: mode === "NORMAL" ? "var(--acc)" : "var(--ok)", color: "var(--acc-on)", fontWeight: 700, letterSpacing: 1.5, padding: "5px 12px", flex: "none" }}>{mode}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 12px", color: "var(--txm)", flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--acc) 5%, transparent)" }}>
              <span style={{ color: "var(--purple)", flex: "none" }}>⎇ {branch || "—"}</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selPath || "no file"}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", padding: "5px 12px", color: "var(--txd)", flex: "none", background: "color-mix(in srgb, var(--acc) 5%, transparent)" }}>
              {note || `utf-8 · ${lineCount}L`}
            </span>
          </div>
          <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", padding: "6px 10px", fontFamily: "'JetBrains Mono',monospace" }}>
            <div style={{ display: "flex", gap: 5, flex: "none" }}>
              <button onClick={() => setMode("NORMAL")} title="normal mode (Esc)" {...hp("esc")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "esc" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 9, letterSpacing: ".5px", padding: "3px 8px" }}>esc</button>
              <button onClick={() => setMode("INSERT")} title="insert mode (i)" {...hp("ins")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)", background: hov === "ins" ? "color-mix(in srgb, var(--ok) 10%, transparent)" : "transparent", color: "var(--ok)", fontFamily: "inherit", fontSize: 9, letterSpacing: ".5px", padding: "3px 8px" }}>i</button>
            </div>
            <span style={{ color: "var(--acc)", flex: "none" }}>:</span>
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={onCmdKey}
              placeholder="w · wq · %s/old/new/g"
              style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
