import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Search, Sparkle, X } from "lucide-react";
import type { GitFile } from "../../api";
import { FileIcon } from "../../lib/fileicon";
import type { Symbol } from "../../lib/symbols";
import type { Hit } from "../../lib/trace";

/* The EDITOR's three newer side views, beside EXPLORER and SEARCH: OUTLINE (the
   open file's definitions, the one holding the cursor lit), REFERENCES (every
   use of a name, ⇧F12) and CHANGES (the branch's uncommitted files — what the
   window's GIT tab was for). Presentational: EditorTab owns the data, these own
   only their scroll and filter. Rows hover in CSS (.trow) like the explorer's. */

const MONO = "'JetBrains Mono',monospace";
const line = (a: number, c = "acc") => `1px solid color-mix(in srgb, var(--${c}) ${a}%, transparent)`;
const tint = (a: number, c = "acc") => `color-mix(in srgb, var(--${c}) ${a}%, transparent)`;

function Head({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px", flex: "none" }}>
      <span className="caps" style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

const KIND: Record<string, [string, string]> = {
  function: ["ƒ", "var(--acc)"], method: ["ƒ", "var(--acc)"], const: ["ƒ", "var(--acc)"],
  class: ["C", "var(--warn)"], struct: ["C", "var(--warn)"], record: ["C", "var(--warn)"],
  interface: ["I", "var(--warn)"], type: ["T", "var(--warn)"], trait: ["I", "var(--warn)"], enum: ["E", "var(--warn)"],
};
export const kindOf = (k: string): [string, string] =>
  KIND[k] ?? KIND[Object.keys(KIND).find((x) => k.includes(x)) ?? ""] ?? ["◇", "var(--ok)"];

export function OutlineView({ file, symbols, current, onJump }: {
  file: string | null; symbols: Symbol[]; current?: Symbol; onJump: (line: number) => void;
}) {
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? symbols.filter((s) => s.name.toLowerCase().includes(t)) : symbols;
  }, [symbols, q]);
  // Follow the cursor: the lit row stays in view as you move through the file.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-cur]")?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <>
      <Head label="Outline">
        <span style={{ fontFamily: MONO, fontSize: "var(--t85)", color: "var(--txl)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{file?.split("/").pop() ?? ""}</span>
      </Head>
      <div style={{ padding: "0 8px 8px", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, border: line(30), background: tint(60, "panel3"), padding: "0 7px", color: "var(--txl)" }}>
          <Search size={12} strokeWidth={1.8} style={{ flex: "none" }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter symbols…" spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setQ(""); } else if (e.key === "Enter" && shown[0]) onJump(shown[0].line); }}
            style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: MONO, fontSize: "var(--t105)", padding: "5px 0" }} />
        </div>
      </div>
      <div ref={listRef} className="mscroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
        {!file && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 12px", fontFamily: MONO }}>Open a file to see its outline.</div>}
        {file && !shown.length && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 12px", fontFamily: MONO }}>{q ? "No matches." : "No definitions in this file."}</div>}
        <div className="vskip-row">
          {shown.map((s) => {
            const on = current?.from === s.from, [g, c] = kindOf(s.kind), depth = q ? 0 : s.depth;
            return (
              <button key={`${s.from}`} className="trow" data-cur={on || undefined} onClick={() => onJump(s.line)} title={`${s.kind} · line ${s.line}`}
                style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? tint(9) : undefined, cursor: "pointer", fontFamily: MONO, textAlign: "left", display: "flex", alignItems: "center", gap: 7, height: 23, padding: "0 10px", paddingLeft: 10 + depth * 14, position: "relative" }}>
                {depth > 0 && <span style={{ position: "absolute", left: 10 + depth * 14 - 8, top: 0, bottom: 0, width: 1, background: tint(14) }} />}
                <span style={{ width: 12, flex: "none", textAlign: "center", fontSize: "var(--t11)", color: c, fontStyle: g === "ƒ" ? "italic" : "normal" }}>{g}</span>
                <span style={{ fontSize: "var(--t11)", color: on ? "var(--txb)" : depth ? "var(--txm)" : "var(--txh)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                <span style={{ fontSize: "var(--t85)", color: "var(--txg)", flex: "none" }}>{s.line}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function RefsView({ title, word, busy, groups, defs, here, onOpen, onAsk, onClose }: {
  title: "References" | "Definitions"; word: string; busy: boolean; groups: [string, Hit[]][];
  /** `path:line` of the definitions among the hits, tagged DEF. */
  defs: Set<string>;
  /** `path:line` you came from, lit. */
  here: string;
  onOpen: (h: Hit) => void; onAsk?: () => void; onClose: () => void;
}) {
  const total = groups.reduce((n, [, l]) => n + l.length, 0);
  const re = useMemo(() => new RegExp(`(?<![\\w$])(${word.replace(/[$]/g, "\\$")})(?![\\w$])`), [word]);
  const lit = (t: string) => {
    const m = re.exec(t);
    if (!m) return t;
    return <>{t.slice(0, m.index)}<span style={{ background: tint(22), color: "var(--txb)" }}>{m[1]}</span>{t.slice(m.index + m[1].length)}</>;
  };
  return (
    <>
      <Head label={title}>
        <span style={{ fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap" }}>{busy ? "…" : `${total} in ${groups.length} file${groups.length === 1 ? "" : "s"}`}</span>
        <button onClick={onClose} title="close" aria-label="close" className="trow"
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txm)", display: "flex", padding: 2 }}><X size={13} strokeWidth={1.8} /></button>
      </Head>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 12px 9px", fontFamily: MONO, fontSize: "var(--t11)", flex: "none" }}>
        <span style={{ color: "var(--acc)", fontStyle: "italic" }}>ƒ</span>
        <span style={{ color: "var(--txb)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{word}</span>
      </div>
      <div className="mscroll" style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto", borderTop: line(8), paddingTop: 4 }}>
        {!busy && !total && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 12px", fontFamily: MONO }}>No {title.toLowerCase()} found.</div>}
        {groups.map(([path, list]) => (
          <div key={path}>
            <div title={path} style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px 0 10px", fontFamily: MONO }}>
              <FileIcon name={path} size={14} />
              <span style={{ fontSize: "var(--t105)", color: "var(--txh)", whiteSpace: "nowrap" }}>{path.split("/").pop()}</span>
              <span style={{ fontSize: "var(--t9)", color: "var(--txl)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{path.split("/").slice(0, -1).join("/")}</span>
              <span style={{ fontSize: "var(--t9)", color: "var(--txl)", flex: "none" }}>{list.length}</span>
            </div>
            {list.map((h) => {
              const k = `${h.path}:${h.line}`, on = k === here;
              return (
                <button key={k} className="trow" onClick={() => onOpen(h)} title={k}
                  style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? tint(9) : undefined, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "baseline", gap: 7, minHeight: 22, padding: "3px 10px 3px 20px" }}>
                  <span style={{ fontFamily: MONO, fontSize: "var(--t85)", color: "var(--txg)", width: 28, textAlign: "right", flex: "none" }}>{h.line}</span>
                  <span className="code" style={{ fontSize: "var(--t10)", color: on ? "var(--txh)" : "var(--txm)", flex: 1, minWidth: 0, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>{lit(h.text)}</span>
                  {defs.has(k) && <span style={{ fontSize: "var(--t75)", letterSpacing: 1, color: "var(--ok)", border: line(40, "ok"), padding: "0 4px", lineHeight: "14px", flex: "none", alignSelf: "center" }}>DEF</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {onAsk && total > 0 && (
        <div style={{ flex: "none", padding: "10px 10px 8px" }}>
          <button onClick={onAsk} title="put this name and its uses in the prompt"
            style={{ width: "100%", appearance: "none", cursor: "pointer", minHeight: 28, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, border: line(38, "purple"), background: tint(9, "purple"), color: "var(--purple-h)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "4px 8px" }}>
            <Sparkle size={11} strokeWidth={2} style={{ color: "var(--purple)", flex: "none" }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>ASK CLAUDE ABOUT {word.toUpperCase()}</span>
          </button>
        </div>
      )}
    </>
  );
}

export function ChangesView({ branch, files, loading, edited, open, onOpen, chunk, onPrev, onNext, onCommit, onReview }: {
  branch: string; files: GitFile[]; loading: boolean;
  /** This session's writes, relative to the tree (lib/sessionedits) — ✦. */
  edited?: Set<string>;
  open: string | null; onOpen: (path: string) => void;
  /** Where the cursor sits among the open file's changes. */
  chunk: { i: number; n: number } | null; onPrev: () => void; onNext: () => void;
  onCommit?: () => void; onReview?: () => void;
}) {
  const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
  const ST = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");
  const btn: React.CSSProperties = { flex: 1, appearance: "none", cursor: "pointer", height: 28, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1 };
  return (
    <>
      <Head label="Changes">
        {files.length > 0 && <span style={{ fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap" }}>
          {files.length} file{files.length === 1 ? "" : "s"} · <span style={{ color: "var(--ok)" }}>+{add}</span> <span style={{ color: "var(--err)" }}>−{del}</span></span>}
      </Head>
      <div style={{ padding: "0 12px 8px", fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)", display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
        <span style={{ whiteSpace: "nowrap", flex: "none" }}>uncommitted on</span>
        <span style={{ color: "var(--purple)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>⎇ {branch || "—"}</span>
        <span style={{ flex: 1 }} />
        {edited && edited.size > 0 && <><Sparkle size={9} strokeWidth={2} style={{ color: "var(--acc)", flex: "none" }} /><span style={{ whiteSpace: "nowrap" }}>this session</span></>}
      </div>
      <div className="mscroll" style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto", borderTop: line(8), paddingTop: 4 }}>
        {!files.length && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 12px", fontFamily: MONO }}>{loading ? "…" : "Working tree clean."}</div>}
        {files.map((f) => {
          const on = f.path === open, name = f.path.split("/").pop() ?? f.path;
          return (
            <button key={f.path} className="trow" onClick={() => onOpen(f.path)} title={f.path}
              style={{ width: "100%", appearance: "none", border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? tint(9) : undefined, cursor: "pointer", fontFamily: MONO, textAlign: "left", display: "flex", alignItems: "center", gap: 7, height: 26, padding: "0 10px" }}>
              <FileIcon name={name} size={14} />
              <span style={{ fontSize: "var(--t105)", color: on ? "var(--txb)" : "var(--txh)", whiteSpace: "nowrap" }}>{name}</span>
              <span style={{ fontSize: "var(--t9)", color: "var(--txl)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{f.path.split("/").slice(0, -1).join("/")}</span>
              {edited?.has(f.path) && <span title="edited this session" style={{ display: "flex", color: "var(--acc)", flex: "none" }}><Sparkle size={10} strokeWidth={2} /></span>}
              <span style={{ fontSize: "var(--t9)", display: "flex", gap: 4, flex: "none" }}><span style={{ color: "var(--ok)" }}>+{f.add}</span>{f.del > 0 && <span style={{ color: "var(--err)" }}>−{f.del}</span>}</span>
              <span style={{ fontSize: "var(--t95)", fontWeight: 700, width: 10, textAlign: "center", flex: "none", color: ST(f.status) }}>{f.status === "?" ? "U" : f.status}</span>
            </button>
          );
        })}
      </div>
      {chunk && chunk.n > 0 && (
        <div style={{ flex: "none", margin: "10px 10px 0", padding: "5px 8px", border: line(14), fontFamily: MONO, fontSize: "var(--t95)", color: "var(--txm)", display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={onPrev} title="previous change · Shift-Alt-F5" className="trow" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txh)", display: "flex", padding: 2 }}><ChevronLeft size={13} strokeWidth={1.8} /></button>
          <span>change <span style={{ color: "var(--txb)" }}>{chunk.i}</span> of {chunk.n}</span>
          <button onClick={onNext} title="next change · Alt-F5" className="trow" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txh)", display: "flex", padding: 2 }}><ChevronRight size={13} strokeWidth={1.8} /></button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: "var(--t85)", color: "var(--txl)" }}>Alt-F5</span>
        </div>
      )}
      {(onCommit || onReview) && files.length > 0 && (
        <div style={{ flex: "none", padding: "10px 10px 8px", display: "flex", gap: 6 }}>
          {onCommit && <button onClick={onCommit} title="commit and push in the rail's GIT tab" style={{ ...btn, border: line(25), background: "transparent", color: "var(--tx)" }}>COMMIT IN GIT ›</button>}
          {onReview && <button onClick={onReview} title="ask Claude to review these changes" style={{ ...btn, border: line(38, "purple"), background: tint(9, "purple"), color: "var(--purple-h)" }}>
            <Sparkle size={11} strokeWidth={2} style={{ color: "var(--purple)" }} />REVIEW</button>}
        </div>
      )}
    </>
  );
}
