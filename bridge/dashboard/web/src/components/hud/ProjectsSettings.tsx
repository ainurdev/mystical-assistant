import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight, ChevronRight, Diamond, EyeOff, GitBranch, GraduationCap, PanelLeft, Pencil, Search, Shapes,
  SquareTerminal, UserRound, WandSparkles, X, type LucideIcon,
} from "lucide-react";
import { api, type AccountInfo, type PickResult } from "../../api";
import { slotHue, type ProfilesInfo } from "../../lib/profiles";
import { agentLabel } from "../../lib/agents";
import { ago, projectGivenName, projectMark, projectName, setProjectMarks } from "../../lib/surfaces";
import { filterRows, folders, parentOf, span, type Show } from "../../lib/projectlist";
import { ProjectTile } from "../ui/ProjectTile";
import type { ProjectGroup } from "./ProjectsPanel";
import MarkEditor, { poss } from "./MarkEditor";
import { RivendellStrip } from "./RivendellMarks";

/* SETTINGS ▸ Projects: every repo the bridge can run in, as a list on the left
   and the one you picked on the right (.mystical/design-drafts/projects-tab, B).
   It was the last fold of AI MANAGEMENT, before that its own tab, and before
   that a modal behind SYSTEM ▸ MANAGE ▸ OPEN, which nobody found.

   Why a list and a detail, not one row per project carrying every control:
   those rows had eight controls each, so 23 repos drew 46 buttons and 23
   identical "Default · <login>" chips, and you kept every folder shut. A row
   now only says which project it is. What you can change sits on the right, in
   one place: the run command, the Claude Design link and lessons lived in three
   other screens.

   ✕ REMOVE is gone. It was kept in one browser only, it took the project out of
   this list as well, and nothing brought it back. HIDE does the useful part, the
   bridge keeps it for every surface, and the HIDDEN filter finds what you hid
   (App turns any old removal into a hide, once). */

export interface ProjectsSettingsProps {
  groups: ProjectGroup[]; // every project, hidden ones included
  hidden: Record<string, boolean>;
  remotes: Record<string, string>; // rel -> owner/repo of origin (GitHub only)
  onSetHidden: (rels: string[], hidden: boolean) => void; // one project, or every one picked
  onRename: (rel: string, name: string) => void; // blank restores the directory name
  // The bridge's profiles and each project's default — the one its new sessions
  // are bound to. Undefined: a bridge older than profiles, so no picker.
  profiles?: ProfilesInfo;
  onSetProfile?: (rel: string, profileId: string) => void | Promise<void>; // "" = no default
  // The Claude logins, so a profile's picker can show whose it is.
  logins?: AccountInfo[];
  // The project modal's DESIGN tab, where a repo is linked to Claude Design:
  // linking queues a prompt into a session, which a settings page can't do.
  onOpenDesign?: (rel: string) => void;
  current?: string | null; // the open session's project, picked first
}

function basename(rel: string): string {
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
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


/** One setting of the picked project: what it is, a line on what it does, its control. */
function Field({ icon: Icon, label, hint, children }: { icon: LucideIcon; label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="prj-field">
      <Icon size={15} strokeWidth={1.7} aria-hidden />
      <div className="prj-lbl"><b>{label}</b><small>{hint}</small></div>
      {children}
    </div>
  );
}

/** What the picked project's mark is, and where it comes from. */
function markHint(rel: string): string {
  const m = projectMark(rel);
  if (m?.auto) return "its own icon, read from the repo";
  if (m?.source === "pick") return m.pick?.how === "frontend" ? `picked: ${projectName(m.pick.from)}'s logo, its frontend`
    : m.pick?.how === "org" ? `picked: ${m.pick.from}'s GitHub picture` : "picked: a brand file in the repo, read afresh";
  if (m?.repo) return "set here: a picture in the repo, read afresh";
  if (m?.source === "rivendell") return m.rv?.own ? "its own logo, from Rivendell" : `${m.rv?.name ?? "its client"}'s logo, from Rivendell`;
  return m && !(m.kind === "letters" && !m.color) ? "set here: it never changes on its own" : "its initials";
}

/** "a and b", "a, b and c", "a, b, c and 2 more". */
function names(rels: string[]): string {
  const n = rels.map((r) => projectName(r));
  const shown = n.length > 4 ? [...n.slice(0, 3), `${n.length - 3} more`] : n;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0] ?? "";
}

/** What PICK LOGOS did, under the toolbar until it's closed: what each project
 *  now wears, what found nothing, and Undo. Inline, not a notice: a notice sits
 *  under the SETTINGS modal and would never be seen. */
function PickStrip({ res, busy, onUndo, onClose }: { res: PickResult | string; busy: boolean; onUndo: () => void; onClose: () => void }) {
  if (typeof res === "string") {
    return (
      <div className="ps-riv prj-picked"><i><WandSparkles size={16} aria-hidden /></i>
        <div><b>Pick logos didn't run</b><small>{res}</small></div>
        <button type="button" className="ps-btn ps-i" title="close" onClick={onClose}><X size={14} /></button>
      </div>
    );
  }
  const { picked, none } = res;
  const wears = picked.slice(0, 3).map((p) => `${projectName(p.rel)} wears ${p.how === "frontend" ? `${poss(projectName(p.from))}, its frontend`
    : p.how === "org" ? `${poss(p.from ?? "its organization")} GitHub picture` : "its brand file"}`);
  if (picked.length > 3) wears.push(`${picked.length - 3} more found one`);
  const lines = [...wears, ...(none.length ? [`${names(none)} ${none.length === 1 ? "has" : "have"} none to wear`] : [])];
  return (
    <div className="ps-riv prj-picked"><i><WandSparkles size={16} aria-hidden /></i>
      <div>
        <b>{picked.length ? `Picked a logo for ${picked.length} project${picked.length === 1 ? "" : "s"}`
          : none.length ? "No logo to pick" : "Every project wears a logo already"}</b>
        <small>{[...lines, "a mark you set stays yours"].join(" · ")}</small>
      </div>
      {picked.length > 0 && <button type="button" className="ps-btn" disabled={busy} onClick={onUndo}>Undo</button>}
      <button type="button" className="ps-btn ps-i" title="close" onClick={onClose}><X size={14} /></button>
    </div>
  );
}

/** The picked project's settings that live in its own config, not in the listing. */
type Cfg = { rel: string; run: string; def: string; design: string | null; lessons: boolean | null };

export function ProjectsSettings(props: ProjectsSettingsProps) {
  const { groups, hidden, remotes, onSetHidden, onRename, profiles, onSetProfile, logins = [], onOpenDesign, current } = props;
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  // The open session's project starts unfolded, so the row on the right is in view.
  const [shut, setShut] = useState<Record<string, boolean>>(() => {
    const s = readShut();
    if (current) delete s[parentOf(current) || "~"];
    return s;
  });
  const searchRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => groups
    .map((g) => ({ ...g, remote: remotes[g.rel] ?? "", hidden: !!hidden[g.rel] }))
    .sort((a, b) => a.rel.localeCompare(b.rel)), [groups, remotes, hidden]);
  const { rows, counts } = filterRows(all, q, show);
  const searching = !!q.trim();
  const secs = folders(rows);
  const isShut = (parent: string) => !searching && !!shut[parent || "~"];
  // The list as drawn, for shift-click: a shut folder's rows aren't in it.
  const order = secs.flatMap((s) => (isShut(s.parent) ? [] : s.rows.map((r) => r.rel)));

  // The project on the right, and the ones picked with ⌘/Ctrl or shift: two or
  // more, and the right side acts on all of them instead.
  const [sel, setSel] = useState<string | null>(() => (current && groups.some((g) => g.rel === current) ? current : null));
  const [picked, setPicked] = useState<string[]>([]);
  const [pickRes, setPickRes] = useState<PickResult | string | null>(null);   // PICK LOGOS' strip, or its error
  const [picking, setPicking] = useState(false);
  // A filter or a search never swaps the project on the right; only a click does.
  const focus = sel && all.some((r) => r.rel === sel) ? sel : order[0] ?? rows[0]?.rel ?? null;
  const chosen = picked.filter((rel) => rows.some((r) => r.rel === rel));
  const many = chosen.length > 1;
  function pick(rel: string, e: React.MouseEvent) {
    let next: string[];
    if (e.metaKey || e.ctrlKey) {
      const base = chosen.length ? chosen : focus ? [focus] : [];
      next = base.includes(rel) ? base.filter((x) => x !== rel) : [...base, rel];
    } else if (e.shiftKey && focus) next = span(order, focus, rel);
    else next = [rel];
    if (next.length > 1) { setPicked(next); if (!e.shiftKey) setSel(rel); }   // shift keeps its anchor
    else { setPicked([]); if (next[0]) setSel(next[0]); }
  }

  const setFold = (next: Record<string, boolean>) => {
    setShut(next);
    try { localStorage.setItem(SHUT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  // "/" finds a project, unless you are typing somewhere already.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Rename in place: the name becomes an input. Esc has to blur (not just
  // unmount) or the blur that follows would save what you were escaping from.
  const [editing, setEditing] = useState<{ rel: string; value: string } | null>(null);
  const cancelled = useRef(false);
  const [markFor, setMarkFor] = useState<{ rel: string; tile: HTMLElement } | null>(null);   // whose mark editor is open
  const bigTile = useRef<HTMLButtonElement>(null);

  // The picked project's own config, read when it is picked. A project listed
  // from its sessions alone (Rivendell jobs) is no repo, so it has none.
  const g = all.find((r) => r.rel === focus) ?? null;
  const repo = !!g && g.rel.startsWith("/");
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [run, setRun] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    setCfg(null); setRun(""); setErr("");
    if (!focus?.startsWith("/")) return;
    let live = true;
    void Promise.all([api.projectSettings({ project: focus }), api.lessons(focus).catch(() => null)])
      .then(([s, l]) => {
        if (!live) return;
        setCfg({ rel: focus, run: s.run_cmd ?? "", def: s.default_cmd, design: s.design_project, lessons: l ? l.repo_enabled : null });
        setRun(s.run_cmd ?? "");
      })
      .catch((e: Error) => { if (live) setErr(`Couldn't read its settings: ${e.message}`); });
    return () => { live = false; };
  }, [focus]);
  function saveRun() {
    if (!cfg || run.trim() === cfg.run) return;
    const rel = cfg.rel;
    api.setProjectSettings({ project: rel }, { run_cmd: run.trim() })
      .then((r) => setCfg((c) => (c?.rel === rel ? { ...c, run: r.run_cmd ?? "" } : c)))
      .catch((e: Error) => setErr(`The run command wasn't saved: ${e.message}`));
  }
  function setLessons(on: boolean) {
    if (!cfg) return;
    const rel = cfg.rel;
    setCfg({ ...cfg, lessons: on });
    api.setLessonsForRepo(rel, on)
      .then((r) => setCfg((c) => (c?.rel === rel ? { ...c, lessons: r.repo_enabled } : c)))
      .catch((e: Error) => { setCfg((c) => (c?.rel === rel ? { ...c, lessons: !on } : c)); setErr(`Lessons didn't change: ${e.message}`); });
  }
  // PICK LOGOS and its Undo: the bridge picks (bridge/projectmarks.pick_all),
  // the tiles take the new marks at once, the strip says what happened.
  const pickLogos = async (action: "pick" | "undo") => {
    setPicking(true);
    try {
      const res = await api.pickLogos(action);
      setProjectMarks((await api.projects()).marks);
      // Pressed again with nothing new to pick: the last run's strip, and its Undo, stay.
      setPickRes((prev) => action === "undo" ? null
        : !res.picked.length && prev && typeof prev !== "string" && prev.picked.length ? prev : res);
    } catch (e) {
      setPickRes(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  const openMark = (rel: string) => {
    const tile = bigTile.current;
    if (tile) setMarkFor((m) => (m?.rel === rel ? null : { rel, tile }));
  };

  const filters: { key: Show; label: string; n: number }[] = [
    { key: "all", label: "All", n: counts.all }, { key: "shown", label: "Shown", n: counts.shown }, { key: "hidden", label: "Hidden", n: counts.hidden },
  ];
  const empty = searching ? <>No project matches “{q.trim()}”. <button type="button" onClick={() => setQ("")}>Clear search</button></>
    : show === "hidden" ? "Nothing is hidden." : show === "shown" ? "Every project is hidden." : "No projects yet: a repo under your projects folder shows up here on its own.";

  return (
    <div className="prj" data-sec="PROJECTS">
      <div className="prj-tools">
        <label className="prj-search">
          <Search size={15} aria-hidden />
          <input ref={searchRef} value={q} placeholder="Find a project: name, folder or GitHub repo" spellCheck={false}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }} />
          {q ? <button type="button" className="prj-clr" title="clear" onClick={() => { setQ(""); searchRef.current?.focus(); }}><X size={12} strokeWidth={2} /></button>
            : <kbd>/</kbd>}
        </label>
        <div className="set-seg prj-show" role="group" aria-label="show">
          {filters.map((f) => (
            <button key={f.key} type="button" data-on={show === f.key || undefined} aria-pressed={show === f.key} onClick={() => setShow(f.key)}>
              {f.label} <small>{f.n}</small>
            </button>
          ))}
        </div>
        <button type="button" className="ps-btn prj-pickbtn" disabled={picking} data-on={(pickRes && typeof pickRes !== "string") || undefined}
          title="Each project still on letters gets its frontend's logo, a brand file of its own, or its GitHub organization's picture"
          onClick={() => void pickLogos("pick")}><WandSparkles size={15} aria-hidden />Pick logos</button>
      </div>
      {pickRes && <PickStrip res={pickRes} busy={picking} onUndo={() => void pickLogos("undo")} onClose={() => setPickRes(null)} />}
      <RivendellStrip />
      <div className="prj-split">
        <div className="prj-list" aria-label="projects">
          {secs.length === 0 && <div className="prj-empty">{empty}</div>}
          {secs.map(({ parent, rows: srows }) => {
            const key = parent || "~";
            const segs = parent ? parent.split("/") : [];
            const open = !isShut(parent);
            const allHidden = srows.every((r) => r.hidden);
            return (
              <div key={key} className="prj-grp">
                <div className="prj-fold">
                  <button type="button" className="prj-foldbtn" aria-expanded={open} disabled={searching}
                    onClick={() => setFold({ ...shut, [key]: open })}>
                    <ChevronRight size={13} strokeWidth={2} aria-hidden className="prj-chev" data-open={open || undefined} />
                    <span className="prj-path">
                      {segs.length === 0 ? <><b>~</b> <i>/</i></> : <>{segs.slice(0, -1).map((s) => <i key={s}>{s} / </i>)}<b>{segs[segs.length - 1]}</b> <i>/</i></>}
                    </span>
                  </button>
                  {!searching && (
                    <button type="button" className="prj-foldact" onClick={() => onSetHidden(srows.map((r) => r.rel), !allHidden)}
                      title={allHidden ? "show every project in this folder in the sidebar" : "hide every project in this folder from the sidebar"}>
                      {allHidden ? "Show all" : "Hide all"}
                    </button>
                  )}
                  <span className="prj-n">{srows.length}</span>
                </div>
                {open && srows.map((r) => {
                  const on = many ? chosen.includes(r.rel) : r.rel === focus;
                  const dot = r.running ? "ok" : (r.badge?.dirty ?? 0) > 0 ? "warn" : null;
                  return (
                    <button key={r.rel} type="button" aria-current={on || undefined} className="prj-row" data-on={on || undefined}
                      data-hidden={r.hidden || undefined} title={r.rel} onClick={(e) => pick(r.rel, e)}>
                      <ProjectTile project={r.rel} />
                      <span className="prj-nm">{r.name}</span>
                      {dot && <i className="prj-dot" data-k={dot} title={dot === "ok" ? "running" : "uncommitted changes"} />}
                      <span className="prj-end">{r.hidden ? <EyeOff size={13} aria-label="hidden" /> : r.sessionCount || ""}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="prj-det">
          {many ? (
            <>
              <div className="prj-bulkhead">
                <b>{chosen.length} projects</b>
                <button type="button" className="ps-btn ps-sm" onClick={() => setPicked([])}>Clear</button>
              </div>
              <div className="prj-tiles">{chosen.map((rel) => <ProjectTile key={rel} project={rel} />)}</div>
              <Field icon={PanelLeft} label="In the sidebar"
                hint={`${chosen.filter((rel) => !hidden[rel]).length} shown · ${chosen.filter((rel) => hidden[rel]).length} hidden`}>
                <span className="prj-acts">
                  <button type="button" className="ps-btn" onClick={() => onSetHidden(chosen, true)}><EyeOff size={13} aria-hidden />Hide</button>
                  <button type="button" className="ps-btn" onClick={() => onSetHidden(chosen, false)}>Show</button>
                </span>
              </Field>
              {profiles && onSetProfile && (() => {
                const repos = chosen.filter((rel) => rel.startsWith("/"));
                const vals = new Set(repos.map((rel) => profiles.project_defaults[rel] ?? ""));
                return repos.length > 0 && (
                  <Field icon={UserRound} label="Starts with" hint={vals.size > 1 ? "they differ now; a pick sets them all" : "what new sessions in each get"}>
                    <ProfilePick value={vals.size === 1 ? [...vals][0] : ""} profiles={profiles} logins={logins}
                      onPick={async (id) => { for (const rel of repos) await onSetProfile(rel, id); }} />
                  </Field>
                );
              })()}
            </>
          ) : !g ? (
            <div className="prj-empty">Pick a project on the left.</div>
          ) : (
            <>
              <div className="prj-id">
                <button ref={bigTile} type="button" className="prj-bigtile" disabled={!repo} onClick={() => openMark(g.rel)}
                  title="its mark: a logo, an icon or its initials">
                  <ProjectTile project={g.rel} />
                </button>
                {markFor?.rel === g.rel && <MarkEditor project={g.rel} name={g.name} anchor={markFor.tile} onClose={() => setMarkFor(null)} />}
                <div className="prj-idtext">
                  {editing?.rel === g.rel ? (
                    <span className="prj-rename">
                      <input autoFocus value={editing.value} placeholder={basename(g.rel) || g.name}
                        onChange={(e) => setEditing({ rel: g.rel, value: e.target.value })}
                        onBlur={() => {
                          if (!cancelled.current) onRename(g.rel, editing.value);
                          cancelled.current = false;
                          setEditing(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
                        }} />
                      <span className="ps-keys">↵ save · esc cancel</span>
                    </span>
                  ) : (
                    <button type="button" className="prj-name" disabled={!repo} title="rename it: a label only, the path stays the key"
                      onClick={() => setEditing({ rel: g.rel, value: projectGivenName(g.rel) || basename(g.rel) || g.name })}>
                      <b>{g.name}</b>{repo && <Pencil size={13} aria-hidden />}
                    </button>
                  )}
                  <div className="prj-sub">
                    <span>{g.rel}</span>
                    {g.remote && (
                      <a href={`https://github.com/${g.remote}`} target="_blank" rel="noreferrer" title={`origin — github.com/${g.remote}`}>
                        · {g.remote} <ArrowUpRight size={11} aria-hidden />
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <div className="prj-stats">
                <div><small>Sessions</small><b>{g.sessionCount}</b></div>
                <div><small>Last used</small><b>{g.running && <i className="prj-dot" data-k="ok" />}{ago(g.sessions[0]?.updated ?? null) || "—"}</b></div>
                <div><small>Branch</small><b>{(g.badge?.dirty ?? 0) > 0 && <i className="prj-dot" data-k="warn" title={`${g.badge?.dirty} uncommitted`} />}
                  <GitBranch size={12} aria-hidden />{g.badge?.branch || "—"}</b></div>
              </div>
              {repo && profiles && onSetProfile && (
                <Field icon={UserRound} label="Starts with" hint="what new sessions here get">
                  <ProfilePick value={profiles.project_defaults[g.rel] ?? ""} profiles={profiles} logins={logins}
                    onPick={(id) => void onSetProfile(g.rel, id)} />
                </Field>
              )}
              <Field icon={PanelLeft} label="In the sidebar" hint="off keeps it out of the sidebar's projects and RECENT">
                <button type="button" className="ps-tog" data-on={!g.hidden || undefined} aria-pressed={!g.hidden}
                  aria-label="in the sidebar" onClick={() => onSetHidden([g.rel], !g.hidden)} />
              </Field>
              {repo && (
                <>
                  <Field icon={Shapes} label="Mark" hint={markHint(g.rel)}>
                    <button type="button" className="ps-btn" onClick={() => openMark(g.rel)}>Change…</button>
                  </Field>
                  <Field icon={SquareTerminal} label="Run command" hint="what RUN starts in the preview">
                    <input className="prj-input" value={run} placeholder={cfg?.def ?? ""} disabled={!cfg} spellCheck={false}
                      aria-label="run command" onChange={(e) => setRun(e.target.value)} onBlur={saveRun}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") { e.stopPropagation(); setRun(cfg?.run ?? ""); }
                      }} />
                  </Field>
                  {onOpenDesign && (
                    <Field icon={Diamond} label="Design system"
                      hint={cfg?.design ? <>linked · <code>{cfg.design.slice(0, 8)}</code></> : "the Claude Design project its UI work follows"}>
                      <button type="button" className="ps-btn" onClick={() => onOpenDesign(g.rel)}>{cfg?.design ? "Open" : "Link…"}</button>
                    </Field>
                  )}
                  <Field icon={GraduationCap} label="Lessons" hint="learn from each turn here">
                    <button type="button" className="ps-tog" data-on={cfg?.lessons || undefined} aria-pressed={!!cfg?.lessons}
                      aria-label="lessons" disabled={cfg?.lessons == null} onClick={() => setLessons(!cfg?.lessons)} />
                  </Field>
                </>
              )}
              {err && <div className="prj-err">{err}</div>}
              <div className="prj-tip">⌘/Ctrl-click or shift-click in the list to change several at once.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
