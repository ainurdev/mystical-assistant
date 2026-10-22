import { useEffect, useRef, useState } from "react";
import { Folder, Search } from "lucide-react";
import { projectName } from "../lib/surfaces";

const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

/** Which of your projects something goes into, when nothing says (a session a teammate
 *  sent from a folder with no repository). Built like AskDialog: the open project first and
 *  picked, a search over the rest, and the confirm button names where it goes. */
export function ProjectPick({ title, text, projects, open, onDone }: {
  title: string;
  text: string;
  projects: string[];          // rels, as the PROJECTS tree lists them
  open?: string | null;        // the project you have open: first, and picked
  onDone: (rel: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const list = [...projects].sort((a, b) => Number(b === open) - Number(a === open) || projectName(a).localeCompare(projectName(b)));
  const [pick, setPick] = useState<string | null>(list[0] ?? null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const shown = list.filter((rel) => !q || `${projectName(rel)} ${rel}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  return (
    <div onClick={() => onDone(null)}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 74%, transparent)", zIndex: 96, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "14vh", animation: "backdropIn .2s ease both" }}>
      <div role="dialog" aria-modal aria-labelledby="pick-title" onClick={(e) => e.stopPropagation()} className="panel ask"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(null); } }}
        style={{ width: 480, maxWidth: "94vw", border: `1px solid ${mix("var(--acc)", 40)}`, background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 60px var(--shadow-modal)", animation: "mslide .2s ease both" }}>
        <div style={{ padding: "18px 18px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div id="pick-title" style={{ fontSize: "var(--t13)", fontWeight: 600, color: "var(--txh)", lineHeight: 1.45 }}>{title}</div>
            <div style={{ marginTop: 6, fontSize: "var(--t12)", color: "var(--txm)", lineHeight: 1.55 }}>{text}</div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", border: `1px solid ${mix("var(--acc)", 30)}`, background: "color-mix(in srgb, var(--panel3) 60%, transparent)", color: "var(--txl)" }}>
            <Search size={13} strokeWidth={2} aria-hidden />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your projects" aria-label="Search your projects"
              onKeyDown={(e) => { if (e.key === "Enter" && (shown[0] || pick)) onDone(shown.includes(pick ?? "") ? pick : shown[0] ?? pick); }}
              style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t12)", outline: "none" }} />
          </label>
          <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: -4 }}>
            {shown.map((rel) => {
              const on = rel === pick;
              return (
                <button key={rel} type="button" role="radio" aria-checked={on} onClick={() => setPick(rel)} onDoubleClick={() => onDone(rel)} style={{
                  appearance: "none", display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: 8, border: 0, cursor: "pointer",
                  textAlign: "left", fontFamily: "inherit", background: on ? mix("var(--acc)", 9) : "transparent",
                }}>
                  <span style={{ flex: "none", width: 14, height: 14, borderRadius: "50%", boxSizing: "border-box", display: "grid", placeItems: "center", border: `1px solid ${on ? "var(--acc)" : "var(--line2)"}` }}>
                    {on && <i style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--acc)" }} />}
                  </span>
                  <span style={{ flex: "none", color: on ? "var(--acc)" : "var(--txl)", display: "flex" }}><Folder size={13} strokeWidth={2} /></span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: "var(--t12)", color: on ? "var(--txh)" : "var(--txm)", fontWeight: on ? 600 : 400 }}>{projectName(rel)}</span>
                    <span style={{ display: "block", fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rel}</span>
                  </span>
                  {rel === open && <span style={{ flex: "none", fontFamily: "var(--mono)", fontSize: "var(--t8)", letterSpacing: 1, color: "var(--ok)" }}>OPEN NOW</span>}
                </button>
              );
            })}
            {!shown.length && <div style={{ padding: "8px", fontSize: "var(--t115)", color: "var(--txl)" }}>No project matches.</div>}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
            <button className="act-alt neutral caps" onClick={() => onDone(null)}>Cancel</button>
            <button className="act-pri caps" disabled={!pick} onClick={() => onDone(pick)}>{pick ? `Continue in ${projectName(pick)}` : "Continue"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
