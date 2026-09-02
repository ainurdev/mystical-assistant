import { useEffect, useMemo, useState } from "react";
import { api, type Doc } from "../../api";
import { ago, projectName } from "../../lib/surfaces";
import { useStickySet } from "../../lib/prefs";
import { Markdown } from "../Markdown";

/* DOCS — the markdown a repo was written with (specs, plans, release notes,
   READMEs, a design brief in .mystical/docs/), listed by the repo that holds
   them and the folder that named the subject, and read right here rather than
   hunted for by name in the FILES tree.

   Scope is ALL, like LEARN: a spec belongs to the repo it was written for, not
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

const OPEN_KEY = "hud-docs-open";

/** The subject a doc belongs to: its folder, with the noise-free tail first.
 *  "docs/superpowers/specs" reads as "specs" — the segment someone named —
 *  with the path above it only as context. */
const subject = (dir: string) => dir.split("/").filter(Boolean).pop() ?? "root";

export function DocsPanel({ project }: { project: string | null }) {
  const [list, setList] = useState<Doc[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Doc | null>(null);
  const [body, setBody] = useState<string | null>(null);
  // Which groups were toggled *away from* their default — so the session's
  // repo stays open without every other repo needing a row in localStorage.
  const [flipped, setFlipped] = useStickySet(OPEN_KEY);
  const [hov, setHov] = useState("");

  useEffect(() => {
    let live = true;
    api.docs("*")
      .then((r) => { if (live) { setList(r.docs); setErr(""); } })
      .catch((e: Error) => { if (live) { setList([]); setErr(e.message); } });
    return () => { live = false; };
  }, []);

  // The open doc's markdown, fetched once per selection. Keyed on project as
  // well as path, because the same `docs/README.md` exists in half the repos.
  const selKey = sel ? `${sel.project ?? project ?? ""} ${sel.path}` : "";
  useEffect(() => {
    if (!sel) return;
    let live = true;
    setBody(null);
    api.doc(sel.project ?? project ?? "", sel.path)
      .then((r) => { if (live) setBody(r.body); })
      .catch((e: Error) => { if (live) setBody(`_could not read this doc — ${e.message}_`); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  // project -> subject folder -> docs, each level newest-first because the
  // flat list already is and the grouping preserves order.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = (list ?? []).filter((a) => !needle ||
      `${a.project ?? ""} ${a.path} ${a.title}`.toLowerCase().includes(needle));
    const byProject = new Map<string, Map<string, Doc[]>>();
    for (const a of rows) {
      const p = a.project ?? "";
      const dirs = byProject.get(p) ?? new Map<string, Doc[]>();
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
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: line }}>
          <button style={btn} onClick={() => setSel(null)}>‹ BACK</button>
          <span style={{ flex: 1, minWidth: 0, fontSize: "var(--t95)", color: "var(--tx)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={`${sel.project ?? ""}/${sel.path}`}>
            {sel.title || sel.name}
          </span>
        </div>
        <div className="mscroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" }}>
          {body === null
            ? <div style={{ ...label, color: "var(--txd)" }}>reading…</div>
            : <div style={{ maxWidth: 720 }}><Markdown>{body}</Markdown></div>}
        </div>
      </div>
    );
  }

  const total = list?.length ?? 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: line }}>
        <span style={label}>Docs</span>
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
            {err || "no markdown on disk yet — a spec, a plan or a README lands here."}
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
                  {projectName(proj)}
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
