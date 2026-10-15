import { useEffect, useRef, useState } from "react";
import { ChevronRight, Pencil } from "lucide-react";
import type { AccountInfo } from "../../api";
import type { ProfilesInfo } from "../../lib/profiles";
import { agentLabel } from "../../lib/agents";
import { projectGivenName, projectName } from "../../lib/surfaces";
import { ProjectTile } from "../ui/ProjectTile";
import { parentOf, type ProjectGroup } from "./ProjectsPanel";

/* The PROJECTS fold of SETTINGS ▸ AI MANAGEMENT: every repo the bridge can run
   in, grouped by the folder that owns it, with the profile its new sessions
   start on. It was its own tab, and before that a modal behind SYSTEM ▸
   MANAGE ▸ OPEN, which nobody found.

   Two things the old row hid: that the name is editable (a tinted chip with
   no affordance — now a pencil beside it), and that HIDE ALL hides an org
   from the sidebar rather than folding the group here (now a chevron folds,
   and HIDE ALL says what it does). */

export interface ProjectsSettingsProps {
  groups: ProjectGroup[]; // manageable projects (removed ones filtered out; hidden included)
  imported: string[];     // locally imported repo paths — TODO(phase2-data): no bridge endpoint yet
  hidden: Record<string, boolean>;
  remotes: Record<string, string>; // rel -> owner/repo of origin (GitHub only)
  onSetHidden: (rels: string[], hidden: boolean) => void; // one row, or a whole org
  onRemove: (rel: string) => void;
  onRename: (rel: string, name: string) => void; // blank restores the directory name
  onImport: (path: string) => void;
  // The bridge's profiles and each project's default — the one its new sessions
  // are bound to. Undefined: a bridge older than profiles, so no picker.
  profiles?: ProfilesInfo;
  onSetProfile?: (rel: string, profileId: string) => void; // "" = no default
  // The Claude logins, so a profile's picker can show whose it is.
  logins?: AccountInfo[];
}

function basename(rel: string): string {
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

const SLOT_HUES = ["var(--acc)", "var(--ask, var(--purple))", "var(--info)", "var(--ok)", "var(--warn)", "var(--purple)"];
function slotHue(slot: string): string {
  const n = Number(slot) || 0;
  return n ? SLOT_HUES[(n - 1) % SLOT_HUES.length] : "var(--panel3)";
}

/** Which folds are shut, kept in this browser. */
const SHUT_KEY = "hud-projects-shut";
function readShut(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(SHUT_KEY) || "{}") as Record<string, boolean>; } catch { return {}; }
}

/** A project's default profile, as a menu grouped by login — the picker the
 *  row shows is a chip with the login's tile, so whose it is reads before
 *  what it is called. */
export function ProfilePick({ value, profiles, logins, onPick, lg, emptyLabel, disabled }: {
  value: string;
  profiles: ProfilesInfo;
  logins: AccountInfo[];
  onPick: (id: string) => void;
  lg?: boolean;          // the page's hero size (the DEFAULT PROFILE fold)
  emptyLabel?: string;   // what "" means here — "Bridge default" on a project row
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const byId = new Map(profiles.profiles.map((p) => [p.id, p]));
  const cur = byId.get(value);
  const bridgeDefault = profiles.default ? byId.get(profiles.default) : undefined;
  const tile = (p: { agent: string; account: string } | undefined) => p
    ? p.agent === "claude"
      ? <span className="ps-av" style={{ background: slotHue(p.account), color: p.account ? "var(--acc-on)" : "var(--txm)" }}>{p.account ? `A${p.account}` : "A"}</span>
      : <span className="ps-av ps-av-agent">◇</span>
    : <span className="ps-av ps-av-agent">A</span>;
  const email = (slot: string) => logins.find((a) => String(a.slot) === slot)?.email ?? (slot ? `A${slot}` : "default login");
  // Groups: each login (by slot, default login first), then each agent.
  const groups: { key: string; head: React.ReactNode; rows: typeof profiles.profiles }[] = [];
  const claude = profiles.profiles.filter((p) => p.agent === "claude");
  const slots = Array.from(new Set(claude.map((p) => p.account))).sort((a, b) => Number(a) - Number(b));
  for (const slot of slots) groups.push({ key: `c${slot}`, head: <>{tile({ agent: "claude", account: slot })}{email(slot)}</>, rows: claude.filter((p) => p.account === slot) });
  for (const agent of Array.from(new Set(profiles.profiles.filter((p) => p.agent !== "claude").map((p) => p.agent))))
    groups.push({ key: agent, head: <>{tile({ agent, account: "" })}{agentLabel(agent)}</>, rows: profiles.profiles.filter((p) => p.agent === agent) });
  return (
    <div ref={ref} className="ps-pickwrap">
      <button type="button" className={lg ? "ps-pick ps-pick-lg" : "ps-pick"} disabled={disabled} onClick={() => setOpen((o) => !o)}
        title={emptyLabel ? "Default profile — what a new session gets unless its project names another" : "Default profile — what a new session in this project is bound to"}>
        {tile(cur ?? (emptyLabel ? undefined : bridgeDefault))}
        <span className="ps-pickname">{cur ? cur.name : emptyLabel ?? "Default"}</span>
        {!cur && !emptyLabel && bridgeDefault && <span className="ps-pickdim">· {bridgeDefault.name}</span>}
        <span className="ps-pickchev">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="ps-menu">
          <button type="button" className="ps-opt" data-on={!value || undefined} onClick={() => { onPick(""); setOpen(false); }}>
            <span className="ps-chk">{!value ? "✓" : ""}</span><span className="ps-optname">{emptyLabel ?? "Bridge default"}</span>
            {!emptyLabel && <span className="ps-k">{bridgeDefault ? bridgeDefault.name : "none"}</span>}
          </button>
          {groups.map((g) => (
            <div key={g.key}>
              <div className="ps-grp">{g.head}</div>
              {g.rows.map((p) => (
                <button key={p.id} type="button" className="ps-opt" data-on={p.id === value || undefined} onClick={() => { onPick(p.id); setOpen(false); }}>
                  <span className="ps-chk">{p.id === value ? "✓" : ""}</span><span className="ps-optname">{p.name}</span>
                  <span className="ps-k">{[p.model.replace(/^claude-/, ""), p.mode.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()].filter(Boolean).join(" · ") || "defaults"}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectsSettings(props: ProjectsSettingsProps) {
  const { groups, imported, hidden, remotes, onSetHidden, onRemove, onRename, onImport, profiles, onSetProfile, logins = [] } = props;
  const [importPath, setImportPath] = useState("");
  const [shut, setShut] = useState<Record<string, boolean>>(readShut);
  // Rename in place: the name becomes an input. Esc has to blur (not just
  // unmount) or the blur that follows would save what you were escaping from.
  const [editing, setEditing] = useState<{ rel: string; value: string } | null>(null);
  const cancelled = useRef(false);

  const rows = [
    ...groups.map((g) => {
      const dirty = g.badge?.dirty ?? 0;
      return { rel: g.rel, name: g.name, dot: g.running ? "var(--ok)" : dirty > 0 ? "var(--warn)" : null, sessionCount: g.sessionCount };
    }),
    // Imported-but-sessionless repos still show here so they can be managed.
    ...imported.filter((rel) => !groups.some((g) => g.rel === rel))
      .map((rel) => ({ rel, name: projectName(rel), dot: null, sessionCount: 0 })),
  ].sort((a, b) => a.rel.localeCompare(b.rel));

  // One section per owning folder — "ainurhq", then "ainurhq/efas" — so a whole
  // org or sub-org can be shown/hidden in one click. Top-level repos share the
  // "~" section. Section position = first member, keeping an org's sub-orgs next
  // to it.
  const sections: { parent: string; rows: typeof rows }[] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const parent = parentOf(r.rel);
    const i = at.get(parent);
    if (i == null) { at.set(parent, sections.length); sections.push({ parent, rows: [r] }); }
    else sections[i].rows.push(r);
  }
  const setFold = (next: Record<string, boolean>) => {
    setShut(next);
    try { localStorage.setItem(SHUT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const allShut = sections.every((s) => shut[s.parent || "~"]);

  const doImport = () => {
    const raw = importPath.trim();
    if (!raw) return;
    onImport(raw);
    setImportPath("");
  };

  return (
    <div className="ps">
      <div className="ps-toolbar">
        <span className="aim-hint">Click a name or its pencil to rename it (a label only — the path stays the key). HIDE keeps a project out of the sidebar; ✕ detaches it.</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ps-btn" onClick={() => setFold(Object.fromEntries(sections.map((s) => [s.parent || "~", !allShut])))}>
          {allShut ? "Expand all" : "Collapse all"}
        </button>
      </div>
      {sections.map(({ parent, rows: srows }) => {
        const key = parent || "~";
        const segs = parent ? parent.split("/") : [];
        const allHidden = srows.every((r) => hidden[r.rel]);
        const hiddenCount = srows.filter((r) => hidden[r.rel]).length;
        const open = !shut[key];
        return (
          <div key={key} className="ps-grp2" data-open={open || undefined}>
            <div className="ps-head">
              <button type="button" className="ps-fold" onClick={() => setFold({ ...shut, [key]: open })} aria-expanded={open}>
                <ChevronRight size={14} aria-hidden className="ps-chev" />
                <b>
                  {segs.length === 0 ? <>~ <i>/</i></> : (
                    <>
                      {segs.slice(0, -1).map((s) => <i key={s}>{s} / </i>)}
                      {segs[segs.length - 1]} <i>/</i>
                    </>
                  )}
                </b>
                <span className="ps-n">{srows.length} repo{srows.length === 1 ? "" : "s"}{hiddenCount ? ` · ${hiddenCount} hidden` : ""}</span>
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" className="ps-btn ps-sm" onClick={() => onSetHidden(srows.map((r) => r.rel), !allHidden)}
                title={allHidden ? "show every repo in this org in the sidebar" : "hide every repo in this org from the sidebar"}>
                {allHidden ? "Show all" : "Hide all"}
              </button>
            </div>
            {open && (
              <div className="ps-rows">
                {srows.map((r) => {
                  const isHidden = !!hidden[r.rel];
                  return (
                    <div key={r.rel} className="ps-row" data-hidden={isHidden || undefined}>
                      <ProjectTile project={r.rel} />
                      <span className="ps-name">
                        {r.dot && <span className="ps-dot" style={{ background: r.dot }} title={r.dot === "var(--ok)" ? "running" : "uncommitted changes"} />}
                        {editing?.rel === r.rel ? (
                          <>
                            <input autoFocus value={editing.value} placeholder={basename(r.rel) || r.name}
                              onChange={(e) => setEditing({ rel: r.rel, value: e.target.value })}
                              onBlur={() => {
                                if (!cancelled.current) onRename(r.rel, editing.value);
                                cancelled.current = false;
                                setEditing(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                                if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
                              }} />
                            <span className="ps-keys">↵ save · esc cancel</span>
                          </>
                        ) : (
                          <>
                            <button type="button" className="ps-rename" title={`${r.rel} — click to rename (display only)`}
                              onClick={() => setEditing({ rel: r.rel, value: projectGivenName(r.rel) || basename(r.rel) || r.name })}>
                              <b>{r.name}</b>
                              <Pencil size={11} aria-hidden />
                            </button>
                            {isHidden && <span className="ps-chip">Hidden</span>}
                            {remotes[r.rel] && (
                              <a href={`https://github.com/${remotes[r.rel]}`} target="_blank" rel="noreferrer" className="ps-remote"
                                title={`origin — github.com/${remotes[r.rel]}`}>{remotes[r.rel]}</a>
                            )}
                          </>
                        )}
                      </span>
                      {profiles && onSetProfile && (
                        <ProfilePick value={profiles.project_defaults[r.rel] ?? ""} profiles={profiles} logins={logins}
                          onPick={(id) => onSetProfile(r.rel, id)} />
                      )}
                      <span className="ps-sess">{r.sessionCount} sess</span>
                      <span className="ps-acts">
                        <button type="button" className="ps-btn ps-sm" data-on={isHidden || undefined} onClick={() => onSetHidden([r.rel], !isHidden)} title={isHidden ? "show in the sidebar" : "hide from the sidebar"}>
                          {isHidden ? "Show" : "Hide"}
                        </button>
                        <button type="button" className="ps-btn ps-i ps-danger" onClick={() => onRemove(r.rel)} title="remove project">✕</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <div className="ps-import">
        <span className="ps-lbl">Import a repo</span>
        <input value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/home/you/dev/my-repo"
          onKeyDown={(e) => e.key === "Enter" && doImport()} />
        <button type="button" className="ps-btn ps-pri" onClick={doImport}>Import</button>
      </div>
    </div>
  );
}
