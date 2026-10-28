import { useMemo, useRef, useState, type CSSProperties } from "react";
import { ImagePlus, Plus, Trash2, X } from "lucide-react";
import type { Workspace } from "../../api";
import { DEFAULT_WS, saveWorkspaces, shrinkPicture, switchWorkspace, useWorkspaces, workspaceOf } from "../../lib/workspaces";
import { ProjectTile } from "../ui/ProjectTile";
import type { ProjectGroup } from "./ProjectsPanel";
import { CARD, Row, Section } from "./SettingsModal";
import { WorkspaceAvatar } from "./WorkspaceButton";

/** SETTINGS → WORKSPACES: add, rename, picture and delete workspaces, and say
 *  which projects each holds (bridge/workspaces.py). Every change saves at
 *  once, the way the rest of this dialog does; the bridge's answer is what
 *  the page shows next, so a refused edit simply doesn't stick and says why. */

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
                <button type="button" title="Pick a picture" style={{ appearance: "none", border: 0, background: "transparent", padding: 0, cursor: "pointer", display: "inline-flex" }}
                  onClick={() => { pickFor.current = w.id; file.current?.click(); }}>
                  <WorkspaceAvatar ws={w} size={26} />
                </button>
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
              {w.image && (
                <button type="button" style={iconBtn} title="Back to the letter" onClick={() => void patch(w.id, { image: null })}>
                  <X size={11} aria-hidden />PICTURE
                </button>
              )}
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
            <span style={{ fontSize: "var(--t95)", color: "var(--txd)", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ImagePlus size={12} aria-hidden /> pictures are cropped square
            </span>
          </div>
          {err && <div style={{ marginTop: 11, fontSize: "var(--t95)", color: "var(--err)" }}>{err}</div>}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden
            onChange={(e) => { void picked(e.target.files?.[0]); e.target.value = ""; }} />
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
