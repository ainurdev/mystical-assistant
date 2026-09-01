import { useEffect, useMemo, useState } from "react";
import { api, type Artifact } from "../../api";
import { ago } from "../../lib/surfaces";
import { useStickySet } from "../../lib/prefs";

/* ARTIFACTS — the standalone HTML pages sitting in your repos (design-first
   mockups, a built graphify map, a one-off report), listed by the repo that
   holds them and the folder that named the subject, and opened in an iframe
   right here rather than in a browser tab you then lose.

   Scope is ALL, like LEARN: a mockup belongs to the repo it was drawn for, not
   to whichever session is focused, so switching sessions must not swap the
   shelf out. The session's own repo is the group that starts open. */

const line = "1px solid color-mix(in srgb, var(--acc) 12%, transparent)";
const label: React.CSSProperties = {
  fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", textTransform: "uppercase",
};
const btn: React.CSSProperties = {
  appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)",
  letterSpacing: 1.5, padding: "3px 8px", background: "transparent", color: "var(--txm)",
  border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
};

const OPEN_KEY = "hud-artifacts-open";

/** The subject a page belongs to: its folder, with the noise-free tail first.
 *  ".mystical/design-drafts/agent-block" reads as "agent-block" — the segment
 *  someone named — with the path above it only as context. */
const subject = (dir: string) => dir.split("/").filter(Boolean).pop() ?? "root";

export function ArtifactsPanel({ project }: { project: string | null }) {
  const [list, setList] = useState<Artifact[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Artifact | null>(null);
  // Which groups were toggled *away from* their default — so the session's
  // repo stays open without every other repo needing a row in localStorage.
  const [flipped, setFlipped] = useStickySet(OPEN_KEY);
  const [hov, setHov] = useState("");

  useEffect(() => {
    let live = true;
    api.artifacts("*")
      .then((r) => { if (live) { setList(r.artifacts); setErr(""); } })
      .catch((e: Error) => { if (live) { setList([]); setErr(e.message); } });
    return () => { live = false; };
  }, []);

  // project -> subject folder -> pages, each level newest-first because the
  // flat list already is and the grouping preserves order.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = (list ?? []).filter((a) => !needle ||
      `${a.project ?? ""} ${a.path} ${a.title}`.toLowerCase().includes(needle));
    const byProject = new Map<string, Map<string, Artifact[]>>();
    for (const a of rows) {
      const p = a.project ?? "";
      const dirs = byProject.get(p) ?? new Map<string, Artifact[]>();
      byProject.set(p, dirs);
      const key = a.dir || "root";
      dirs.set(key, [...(dirs.get(key) ?? []), a]);
    }
    return [...byProject.entries()];
  }, [list, q]);

  // Searching opens everything it matched — a hit inside a shut group is a hit
  // you cannot see. The session's repo is open by default; the rest remember.
  const searching = !!q.trim();
  const isOpen = (p: string) => searching || flipped.has(p) !== (p === project);
  const toggle = (p: string) => setFlipped((o) => {
    const n = new Set(o);
    if (!n.delete(p)) n.add(p);
    return n;
  });

  if (sel) {
    const url = api.artifactUrl(sel.project ?? project ?? "", sel.path);
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: line }}>
          <button style={btn} onClick={() => setSel(null)}>‹ BACK</button>
          <span style={{ flex: 1, minWidth: 0, fontSize: "var(--t95)", color: "var(--tx)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={`${sel.project ?? ""}/${sel.path}`}>
            {sel.title || sel.name}
          </span>
          <a href={url} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }}>↗</a>
        </div>
        {/* Sandboxed: these pages are ours, but they are also whatever the model
            last wrote, and they must not reach the dashboard's own origin. */}
        <iframe key={url} src={url} title={sel.name} sandbox="allow-scripts"
          style={{ flex: 1, width: "100%", border: 0, background: "var(--panel3)" }} />
      </div>
    );
  }

  const total = list?.length ?? 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: line }}>
        <span style={label}>Artifacts</span>
        <span style={{ ...label, color: "var(--txd)" }}>{list ? `${total}` : "…"}</span>
      </div>
      <div style={{ padding: "8px 10px", borderBottom: line }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
          style={{ width: "100%", background: "transparent", border: line, color: "var(--tx)",
            fontFamily: "inherit", fontSize: "var(--t95)", padding: "4px 7px", outline: "none" }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!list && <div style={{ ...label, padding: 12 }}>reading…</div>}
        {list && !total && (
          <div style={{ ...label, padding: 12, lineHeight: 1.7 }}>
            {err || "no html pages on disk yet — a /design-first mockup lands here."}
          </div>
        )}
        {groups.map(([proj, dirs]) => {
          const count = [...dirs.values()].reduce((n, v) => n + v.length, 0);
          const shown = isOpen(proj);
          return (
            <div key={proj}>
              <button onClick={() => toggle(proj)}
                style={{ ...btn, border: 0, borderBottom: line, width: "100%", display: "flex",
                  alignItems: "center", gap: 7, padding: "6px 10px", textAlign: "left" }}>
                <span style={{ color: "var(--txd)" }}>{shown ? "▾" : "▸"}</span>
                <span style={{ flex: 1, minWidth: 0, color: "var(--acc)", whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis" }}>
                  {proj.split("/").pop() || proj}
                </span>
                <span style={{ color: "var(--txd)" }}>{count}</span>
              </button>
              {shown && [...dirs.entries()].map(([dir, rows]) => (
                <div key={dir}>
                  <div style={{ ...label, padding: "7px 10px 3px 22px", color: "var(--txd)" }}
                    title={dir}>{subject(dir)}</div>
                  {rows.map((a) => {
                    const key = `${proj}/${a.path}`;
                    return (
                      <button key={key} onClick={() => setSel(a)}
                        onMouseEnter={() => setHov(key)} onMouseLeave={() => setHov("")}
                        style={{ appearance: "none", border: 0, width: "100%", textAlign: "left",
                          cursor: "pointer", fontFamily: "inherit", display: "flex", gap: 8,
                          alignItems: "baseline", padding: "3px 10px 3px 22px",
                          background: hov === key ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent" }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: "var(--t95)", color: "var(--tx)",
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                          title={a.path}>{a.title || a.name}</span>
                        <span style={{ fontSize: "var(--t9)", color: "var(--txd)", whiteSpace: "nowrap" }}>
                          {ago(a.at)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
