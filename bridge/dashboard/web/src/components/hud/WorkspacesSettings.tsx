import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Plus, Trash2, Upload, Type } from "lucide-react";
import { projectLogoUrl, type Workspace, type WorkspaceDisplay } from "../../api";
import { projectMark } from "../../lib/surfaces";
import { DEFAULT_WS, saveWorkspaces, setWorkspaceDisplay, shrinkPicture, switchWorkspace, useWorkspaces, workspaceOf } from "../../lib/workspaces";
import { ProjectTile } from "../ui/ProjectTile";
import type { ProjectGroup } from "./ProjectsPanel";
import { CARD, Row, Section } from "./SettingsModal";
import { WorkspaceAvatar } from "./WorkspaceButton";

/** SETTINGS → WORKSPACES: add, rename, picture and delete workspaces, and say
 *  which projects each holds (bridge/workspaces.py). Every change saves at
 *  once, the way the rest of this dialog does; the bridge's answer is what
 *  the page shows next, so a refused edit simply doesn't stick and says why.
 *
 *  An avatar's picture comes from the picker under it: any project's logo, or
 *  a file you upload. A logo is copied, not linked: the workspace keeps its
 *  picture if the project changes or loses its mark (projectmarks.py drops a
 *  logo nothing wears), and both go through the one upload path. */

const field: CSSProperties = {
  background: "var(--panel3)", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", outline: "none",
  color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 0.5, padding: "6px 8px",
};
const iconBtn: CSSProperties = {
  appearance: "none", cursor: "pointer", flex: "none", display: "inline-flex", alignItems: "center", gap: 6,
  border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent",
  color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "5px 9px",
};

const plural = (n: number) => `${n} project${n === 1 ? "" : "s"}`;
const newId = () => "w-" + Math.random().toString(36).slice(2, 10).padEnd(8, "0");

export function WorkspacesSettings({ groups }: { groups: ProjectGroup[] }) {
  const { set, cur } = useWorkspaces();
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [sure, setSure] = useState("");          // the workspace whose DELETE was pressed once
  const pickFor = useRef<string>("");
  const file = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState("");    // the workspace whose picture picker is open
  const list = set?.workspaces ?? [];
  const assign = set?.assign ?? {};

  async function save(ws: Workspace[], as: Record<string, string>, images?: Record<string, string>) {
    setErr("");
    try { await saveWorkspaces(ws, as, images); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't save the workspaces"); }
  }
  const patch = (id: string, p: Partial<Workspace>) => save(list.map((w) => (w.id === id ? { ...w, ...p } : w)), assign);

  function add() {
    const w = { id: newId(), name: `Workspace ${list.length + 1}`, image: null };
    void save([...list, w], assign);
  }
  function drop(id: string) {
    if (sure !== id) { setSure(id); window.setTimeout(() => setSure((s) => (s === id ? "" : s)), 3000); return; }
    setSure("");
    void save(list.filter((w) => w.id !== id), assign);
  }
  async function picked(f: File | undefined) {
    const id = pickFor.current;
    if (!f || !id) return;
    try { await save(list, assign, { [id]: await shrinkPicture(f) }); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't read that picture"); }
  }
  async function fromLogo(id: string, logo: string) {
    setPicking("");
    try {
      const r = await fetch(projectLogoUrl(logo));
      if (!r.ok) throw new Error("that logo couldn't be read");
      await save(list, assign, { [id]: await shrinkPicture(await r.blob()) });
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't use that logo"); }
  }
  // Every project logo once, named for the first project wearing it.
  const logos = useMemo(() => {
    const seen = new Map<string, string>();
    for (const g of [...groups].sort((a, b) => a.name.localeCompare(b.name))) {
      const m = projectMark(g.rel);
      if (m?.kind === "logo" && m.logo && !seen.has(m.logo)) seen.set(m.logo, g.name);
    }
    return [...seen].map(([logo, name]) => ({ logo, name }));
  }, [groups]);
  function move(key: string, to: string) {
    const next = { ...assign };
    if (to === DEFAULT_WS) delete next[key]; else next[key] = to;
    void save(list, next);
  }

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...groups]
      .filter((g) => !s || g.name.toLowerCase().includes(s) || g.rel.toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [groups, q]);

  if (!set) return <div style={{ ...CARD, color: "var(--txd)", fontSize: "var(--t10)" }}>Reading the workspaces…</div>;

  return (
    <>
      <Section title="YOUR WORKSPACES" desc="Click an avatar to give it a picture; without one it shows the name's first letter. Deleting a workspace sends its projects back to Default, which can be renamed but not deleted.">
        <div style={CARD}>
          {list.map((w, i) => (
            <Row key={w.id} first={i === 0} label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                <span style={{ position: "relative", display: "inline-flex" }}>
                  <button type="button" title="Pick a picture" aria-expanded={picking === w.id}
                    style={{ appearance: "none", border: 0, background: "transparent", padding: 0, cursor: "pointer", display: "inline-flex" }}
                    onClick={() => setPicking((p) => (p === w.id ? "" : w.id))}>
                    <WorkspaceAvatar ws={w} size={26} />
                  </button>
                  {picking === w.id && (
                    <PicturePick logos={logos} hasImage={!!w.image} onClose={() => setPicking("")}
                      onLogo={(logo) => void fromLogo(w.id, logo)}
                      onUpload={() => { setPicking(""); pickFor.current = w.id; file.current?.click(); }}
                      onLetter={() => { setPicking(""); void patch(w.id, { image: null }); }} />
                  )}
                </span>
                <input key={`${w.id}:${w.name}`} defaultValue={w.name} aria-label="workspace name" maxLength={40}
                  style={{ ...field, width: 180 }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== w.name) void patch(w.id, { name: v }); else e.target.value = w.name; }} />
              </span>
            }>
              <span style={{ fontSize: "var(--t95)", color: "var(--txd)" }}>
                {w.id === DEFAULT_WS ? "unassigned projects" : plural(Object.values(assign).filter((v) => v === w.id).length)}
                {w.id === cur ? " · showing" : ""}
              </span>
              {w.id !== cur && <button type="button" style={iconBtn} onClick={() => switchWorkspace(w.id)}>SHOW</button>}
              {w.id !== DEFAULT_WS && (
                <button type="button" style={{ ...iconBtn, ...(sure === w.id ? { color: "var(--err)", borderColor: "var(--err)" } : {}) }}
                  title="Its projects go back to Default" onClick={() => drop(w.id)}>
                  <Trash2 size={11} aria-hidden />{sure === w.id ? "SURE?" : "DELETE"}
                </button>
              )}
            </Row>
          ))}
          <div style={{ marginTop: 13, paddingTop: 13, borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" style={{ ...iconBtn, color: "var(--txb)", borderColor: "var(--acc)" }} onClick={add}>
              <Plus size={12} aria-hidden />ADD WORKSPACE
            </button>

          </div>
          {err && <div style={{ marginTop: 11, fontSize: "var(--t95)", color: "var(--err)" }}>{err}</div>}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden
            onChange={(e) => { void picked(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </Section>

      <Section top title="SWITCHER" desc="How the sidebar shows them: one button that opens a menu, or a row with a button for each workspace.">
        <div style={CARD}>
          <Row first label="SIDEBAR SWITCH">
            {(["menu", "row"] as WorkspaceDisplay[]).map((d) => (
              <button key={d} type="button" aria-pressed={set.display === d}
                style={{ ...iconBtn, ...(set.display === d ? { color: "var(--txb)", borderColor: "var(--acc)", background: "color-mix(in srgb, var(--acc) 12%, transparent)" } : {}) }}
                onClick={() => void setWorkspaceDisplay(d).catch((e) => setErr(e instanceof Error ? e.message : "couldn't save that"))}>
                {d === "menu" ? "MENU" : "ROW OF BUTTONS"}
              </button>
            ))}
          </Row>
        </div>
      </Section>

      <Section top title="PROJECTS" desc="Which workspace each project lists in. A project is in exactly one; moving it takes it out of the others.">
        <div style={CARD}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project" aria-label="find a project"
            style={{ ...field, width: "100%", boxSizing: "border-box", marginBottom: 6 }} />
          {rows.map((g, i) => (
            <Row key={g.rel} first={i === 0} label={
              <span style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
                <ProjectTile project={g.rel} />
                <span style={{ color: "var(--txb)" }}>{g.name}</span>
                <span style={{ marginLeft: 8, color: "var(--txl)", letterSpacing: 0, overflowWrap: "anywhere" }}>{g.rel}</span>
              </span>
            }>
              <select value={workspaceOf(set, g.rel)} aria-label={`${g.name}: workspace`}
                onChange={(e) => move(g.rel, e.target.value)} style={{ ...field, padding: "4px 6px" }}>
                {list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Row>
          ))}
          {!rows.length && <div style={{ fontSize: "var(--t10)", color: "var(--txd)" }}>No project matches.</div>}
        </div>
      </Section>
    </>
  );
}

/** The picker under a workspace's avatar: every project logo to copy, then
 *  UPLOAD for a file of your own and, with a picture set, back to the letter. */
function PicturePick({ logos, hasImage, onLogo, onUpload, onLetter, onClose }: {
  logos: { logo: string; name: string }[];
  hasImage: boolean;
  onLogo: (logo: string) => void;
  onUpload: () => void;
  onLetter: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    // Outside the picker, and not on the avatar that toggles it (its own click does that).
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !box.current?.parentElement?.contains(t)) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc, true); };
  }, [onClose]);
  const s = q.trim().toLowerCase();
  const shown = s ? logos.filter((l) => l.name.toLowerCase().includes(s)) : logos;
  return (
    <div ref={box} className="wspick" role="dialog" aria-label="Workspace picture">
      <div className="wspick-h">Use a project's logo</div>
      {logos.length > 12 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project" aria-label="find a logo"
          className="wspick-q" autoFocus />
      )}
      {shown.length ? (
        <div className="wspick-grid">
          {shown.map((l) => (
            <button key={l.logo} type="button" className="wspick-logo" title={l.name} onClick={() => onLogo(l.logo)}>
              <img src={projectLogoUrl(l.logo)} alt={l.name} draggable={false} />
            </button>
          ))}
        </div>
      ) : (
        <div className="wspick-none">{logos.length ? "No project matches." : "No project has a logo yet."}</div>
      )}
      <div className="wspick-foot">
        <button type="button" onClick={onUpload}><Upload size={12} aria-hidden />Upload a picture</button>
        {hasImage && <button type="button" onClick={onLetter}><Type size={12} aria-hidden />Use the letter</button>}
      </div>
    </div>
  );
}
