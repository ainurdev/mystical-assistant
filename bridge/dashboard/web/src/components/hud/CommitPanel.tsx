import { useCallback, useEffect, useState } from "react";
import { api, type GitFile } from "../../api";

/* Working-tree commit: pick uncommitted files in the selected branch's worktree,
   generate a message (one-shot Claude), and commit just those — leaving the rest
   dirty. Sits behind the "Working Tree" toggle in the Changes tab. */

const FILE_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");

export function CommitPanel({ project, branch }: { project: string; branch: string }) {
  const [files, setFiles] = useState<GitFile[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pushAfter, setPushAfter] = useState(false);
  const [banner, setBanner] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    void api.git(project, branch)
      .then((g) => { setFiles(g.files); setSel(new Set(g.files.map((f) => f.path))); })
      .catch(() => { setFiles([]); setSel(new Set()); });
  }, [project, branch]);

  // reload + reset when the worktree (project/branch) changes
  useEffect(() => { load(); setFocus(null); setMessage(""); setNote(""); }, [load]);

  const focusName = focus ?? files[0]?.path ?? null;
  useEffect(() => {
    if (!focusName) { setDiff(""); return; }
    void api.gitDiff(project, focusName, undefined, undefined, branch)
      .then((d) => setDiff(d.diff)).catch(() => setDiff(""));
  }, [focusName, project, branch]);

  function toggle(p: string) {
    setSel((prev) => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  }
  const allOn = files.length > 0 && sel.size === files.length;
  const toggleAll = () => setSel(allOn ? new Set() : new Set(files.map((f) => f.path)));

  async function generate() {
    if (!sel.size || generating) return;
    setGenerating(true); setNote("");
    try {
      const r = await api.commitMessage(project, branch, [...sel]);
      if (r.message) setMessage(r.message);
      else setNote(r.error || "couldn't generate — type a message");
    } catch (e) { setNote((e as Error).message); }
    finally { setGenerating(false); }
  }

  async function commit() {
    if (!sel.size || !message.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.gitCommit(project, message.trim(), [...sel], branch);
      if (!r.ok) { setBanner(`Commit failed: ${r.output}`); setTimeout(() => setBanner(""), 6000); return; }
      let m = `Committed ${sel.size} file${sel.size > 1 ? "s" : ""}`;
      if (pushAfter) { const p = await api.gitPush(project, branch); m += p.ok ? " · pushed" : ` · push failed: ${p.output}`; }
      setBanner(m); setMessage(""); load();
      setTimeout(() => setBanner(""), 5000);
    } finally { setBusy(false); }
  }

  const focusFile = files.find((f) => f.path === focusName);
  const lines = diff.split("\n");

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", animation: "mslide .3s ease both" }}>
      {banner && (
        <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontSize: 10.5, padding: "8px 11px", marginBottom: 11, fontFamily: "'JetBrains Mono',monospace", flex: "none" }}>▸ {banner}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11, flex: "none" }}>
        <button onClick={toggleAll} disabled={!files.length} style={{ appearance: "none", cursor: files.length ? "pointer" : "default", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "4px 9px" }}>{allOn ? "NONE" : "ALL"}</button>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--txl)" }}>{sel.size}/{files.length} SELECTED · <span style={{ color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace" }}>⎇ {branch || "—"}</span></span>
      </div>

      {files.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace", padding: "6px 2px" }}>Working tree clean on {branch || "this branch"}.</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", flex: 1, minHeight: 0 }}>
            {/* file list with checkboxes */}
            <div style={{ borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--txl)", padding: "11px 12px 8px", flex: "none" }}>CHANGES · {files.length}</div>
              <div className="mscroll" style={{ flex: 1, minHeight: 0 }}>
                {files.map((f) => {
                  const on = f.path === focusName;
                  const checked = sel.has(f.path);
                  return (
                    <div key={f.path} onClick={() => setFocus(f.path)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer", borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent" }}>
                      <input type="checkbox" checked={checked} onChange={() => toggle(f.path)} onClick={(e) => e.stopPropagation()}
                        style={{ accentColor: "var(--acc)", cursor: "pointer", flex: "none", width: 13, height: 13 }} />
                      <span style={{ fontSize: 11, fontWeight: 700, width: 13, textAlign: "center", flex: "none", color: FILE_COLOR(f.status), fontFamily: "'JetBrains Mono',monospace" }}>{f.status}</span>
                      <span style={{ fontSize: 11, color: on ? "var(--txb)" : checked ? "var(--txm)" : "var(--txf)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left", fontFamily: "'JetBrains Mono',monospace" }}>{f.path}</span>
                      <span style={{ fontSize: 10, flex: "none", display: "flex", gap: 5, fontFamily: "'JetBrains Mono',monospace" }}><span style={{ color: "var(--ok)" }}>+{f.add}</span><span style={{ color: "var(--err)" }}>−{f.del}</span></span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* diff of the focused file */}
            <div style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, flex: "none" }}>
                <span style={{ color: FILE_COLOR(focusFile?.status ?? "M"), fontWeight: 700 }}>{focusFile?.status ?? ""}</span>
                <span style={{ flex: 1, color: "var(--txb)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{focusName || ""}</span>
              </div>
              <div className="mscroll" style={{ flex: 1, minHeight: 0, overflowX: "auto", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, lineHeight: 1.7 }}>
                {lines.map((ln, i) => {
                  const kind = ln.startsWith("@@") ? "hunk" : ln.startsWith("+") ? "add" : ln.startsWith("-") ? "del" : "ctx";
                  const map = { add: { bg: "color-mix(in srgb, var(--ok) 7%, transparent)", c: "#a7e6c3" }, del: { bg: "color-mix(in srgb, var(--err) 7%, transparent)", c: "#f0b0a8" }, hunk: { bg: "color-mix(in srgb, var(--acc) 6%, transparent)", c: "var(--acc)" }, ctx: { bg: "transparent", c: "var(--txd)" } }[kind];
                  return <div key={i} style={{ display: "flex", background: map.bg, padding: "0 10px", minWidth: "max-content" }}><span style={{ color: map.c, whiteSpace: "pre", flex: 1 }}>{ln || " "}</span></div>;
                })}
              </div>
            </div>
          </div>

          {/* commit bar */}
          <div style={{ flex: "none", marginTop: 11, border: "1px solid color-mix(in srgb, var(--purple) 28%, transparent)", background: "color-mix(in srgb, var(--purple) 4%, transparent)", padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--txl)" }}>COMMIT MESSAGE</span>
              <span style={{ flex: 1 }} />
              {note && <span style={{ fontSize: 9.5, color: "var(--warn)", fontFamily: "'JetBrains Mono',monospace" }}>{note}</span>}
              <button onClick={generate} disabled={!sel.size || generating}
                title={sel.size ? "generate from selected files" : "select files first"}
                style={{ appearance: "none", cursor: sel.size && !generating ? "pointer" : "not-allowed", border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "5px 10px", opacity: generating ? 0.6 : 1 }}>{generating ? "✦ GENERATING…" : "✦ GENERATE MESSAGE"}</button>
            </div>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="commit message…" rows={2}
              style={{ width: "100%", boxSizing: "border-box", resize: "vertical", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, lineHeight: 1.5, padding: "7px 9px" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 9 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 9.5, letterSpacing: 1, color: "var(--txd)" }}>
                <input type="checkbox" checked={pushAfter} onChange={(e) => setPushAfter(e.target.checked)} style={{ accentColor: "var(--acc)", cursor: "pointer" }} />PUSH AFTER
              </label>
              <span style={{ flex: 1 }} />
              <button onClick={commit} disabled={!sel.size || !message.trim() || busy}
                style={{ appearance: "none", cursor: sel.size && message.trim() && !busy ? "pointer" : "not-allowed", border: "1px solid var(--ok)", background: "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "8px 16px", opacity: !sel.size || !message.trim() || busy ? 0.45 : 1 }}>▸ COMMIT {sel.size} FILE{sel.size === 1 ? "" : "S"}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
