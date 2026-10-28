import { useEffect, useMemo, useState } from "react";
import {
  Code2, FlaskConical, GitCommitVertical, GraduationCap, ListTodo, Palette, PenLine,
  Play, Puzzle, Scissors, ShieldQuestion, Sparkles, Waypoints, Workflow, type LucideIcon,
} from "lucide-react";
import {
  api, type AiFeature, type CatalogSkill, type InstalledSkill, type SkillCategory, type SkillScope, type SkillsInfo,
} from "../../api";
import { setAiFeatures } from "../../lib/ai";
import { PluginsView } from "./SkillsTab";

/* SETTINGS ▸ AI MANAGEMENT ▸ SKILLS — one fold, two kinds of card.

   The extras (every model call the bridge makes on top of your own turns —
   titles, guards, lessons) and the skills (a SKILL.md under .claude/skills/,
   from the catalog or by hand) used to live two tabs apart in two idioms: the
   extras as a grid of switch cards, the skills as the sidebar's ruled list.
   They answer the same question — what does a session carry that you didn't
   type — so they share one card grammar here: an icon, a name, what it does,
   and on the card's floor what it costs or where it came from. The switch or
   the install button sits where the eye lands first, top right.

   SkillsTab.tsx keeps the HUD-styled list for the ANALYZE modal; this is the
   settings page's view, authored in FLINT's idiom with the page's tokens. */

// One icon per extra: a grid of ten cards is scanned by shape long before it
// is read, and these are otherwise ten identical rectangles.
const EXTRA_ICONS: Record<string, LucideIcon> = {
  title: PenLine,
  relevance: ShieldQuestion,
  nextup: ListTodo,
  preview: Play,
  learn: GraduationCap,
  ponytail: Scissors,
  graph: Waypoints,
  commitmsg: GitCommitVertical,
};

const CAT_ICON: Record<SkillCategory, LucideIcon> = {
  development: Code2,
  design: Palette,
  writing: PenLine,
  testing: FlaskConical,
  workflow: Workflow,
  other: Puzzle,
};
const CAT_COLOR: Record<SkillCategory, string> = {
  development: "var(--acc)",
  design: "var(--purple)",
  writing: "var(--info)",
  testing: "var(--ok)",
  workflow: "var(--warn)",
  other: "var(--txd)",
};
const CATS: { k: SkillCategory | "all"; l: string }[] = [
  { k: "all", l: "All" },
  { k: "development", l: "Dev" },
  { k: "design", l: "Design" },
  { k: "writing", l: "Writing" },
  { k: "testing", l: "Testing" },
  { k: "workflow", l: "Workflow" },
  { k: "other", l: "Other" },
];
const catLabel = (c: SkillCategory) => CATS.find((x) => x.k === c)?.l ?? c;

/** The bridge names an extra in capitals ("AUTO TITLES"); the page speaks in
 *  sentence case. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** FLINT's toggle — the markup SettingsModal's Switch renders inside FlintCtx. */
function Toggle({ on, busy, onClick, label }: { on: boolean; busy?: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="set-toggle" role="switch" aria-checked={on} aria-label={label}
      data-on={on || undefined} disabled={busy} onClick={onClick}><i /></button>
  );
}

// ---- the extras --------------------------------------------------------------

function ExtraCard({ f, busy, err, open, onToggle, onInfo }: {
  f: AiFeature; busy: boolean; err?: string; open: boolean; onToggle: () => void; onInfo: () => void;
}) {
  const Icon = EXTRA_ICONS[f.key] ?? Sparkles;
  return (
    <div className="aim-x" data-on={f.enabled || undefined} data-busy={busy || undefined}>
      <div className="aim-xhd">
        <span className="aim-xic"><Icon size={14} strokeWidth={1.7} aria-hidden /></span>
        <b>{sentence(f.label)}</b>
        {f.about && (
          <button type="button" className="aim-xinfo" aria-expanded={open} aria-label={`about ${f.label}`} onClick={onInfo}>i</button>
        )}
        <span style={{ flex: 1, minWidth: 8 }} />
        <Toggle on={f.enabled} busy={busy} onClick={onToggle} label={f.label} />
      </div>
      <div className="aim-xhint">{f.hint}</div>
      {open && f.about && <div className="aim-xaside">{f.about}</div>}
      {err && <div className="aim-xerr">{err}</div>}
      <div className="aim-xfoot">
        <span>{f.cost}</span>
        {f.tokens && <em>{f.tokens}</em>}
      </div>
    </div>
  );
}

/** Anything that runs on its own ships off: an install should cost exactly the
 *  turns you typed until you decide otherwise. A switch applies to the next
 *  turn — nothing to restart. */
function ExtrasGrid() {
  const [rows, setRows] = useState<AiFeature[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A failure belongs on the card whose switch just refused to move.
  const [err, setErr] = useState<{ key: string; msg: string } | null>(null);
  // Which card's ⓘ is unfolded — the grid stretches rows so the cost lines
  // align, and one open aside would stretch its neighbours into mostly gap.
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    void api.aiFeatures()
      .then((r) => { setRows(r.features); setAiFeatures(r.features); })
      .catch(() => setRows([]));
  }, []);

  async function toggle(f: AiFeature) {
    setBusy(f.key);
    setErr(null);
    try {
      const fresh = (await api.setAiFeature(f.key, !f.enabled)).features;
      setRows(fresh);
      // The switch owns visible UI elsewhere (tabs, boards, cards) — hand the
      // fresh answer to the shared store so it appears/disappears right now.
      setAiFeatures(fresh);
    } catch (e) {
      setErr({ key: f.key, msg: e instanceof Error ? e.message : "could not save" });
    } finally {
      setBusy(null);
    }
  }

  const on = rows?.filter((f) => f.enabled).length ?? 0;
  return (
    <>
      <div className="aim-sub" data-sec="MODEL-SPENDING EXTRAS">
        <b>Extras that spend model calls</b>
        {rows && rows.length > 0 && <span className="aim-count">{on} of {rows.length} on</span>}
        <span className="aim-hint">calls you didn't type — each has its switch</span>
      </div>
      {rows === null && <div className="aim-hint">Reading the feature switches…</div>}
      {rows?.length === 0 && <div className="aim-hint">This bridge is running a build without the extras. Restart it.</div>}
      {rows && rows.length > 0 && (
        <div className="aim-xgrid" data-open={openKey ? "" : undefined}>
          {rows.map((f) => (
            <ExtraCard key={f.key} f={f} busy={busy === f.key} err={err?.key === f.key ? err.msg : undefined}
              open={openKey === f.key} onToggle={() => void toggle(f)}
              onInfo={() => setOpenKey(openKey === f.key ? null : f.key)} />
          ))}
        </div>
      )}
    </>
  );
}

// ---- the skills --------------------------------------------------------------

function SkillCard({ s, busy, onRemove, onUpdate }: {
  s: InstalledSkill;
  busy: boolean;
  onRemove: (() => void) | null;   // catalog skills only — a hand-written one is edited on disk
  onUpdate: (() => void) | null;   // set when the source repo has moved on
}) {
  const Icon = CAT_ICON[s.category] ?? Puzzle;
  return (
    <div className="aim-x" data-busy={busy || undefined}>
      <div className="aim-xhd">
        <span className="aim-xic" style={{ color: CAT_COLOR[s.category] }}><Icon size={14} strokeWidth={1.7} aria-hidden /></span>
        <b title={s.id}>{s.name}</b>
        <span style={{ flex: 1, minWidth: 8 }} />
        {onUpdate && (
          <button type="button" className="aim-xbtn warn" disabled={busy} onClick={onUpdate} title="the source repo changed — pull the new version">↻ Update</button>
        )}
        {onRemove ? (
          <button type="button" className="aim-xbtn danger" disabled={busy} onClick={onRemove} title="uninstall">✕</button>
        ) : (
          <span className="aim-chip dim" title="hand-written — edit it on disk">own</span>
        )}
      </div>
      {s.description && <div className="aim-xhint clamp" title={s.description}>{s.description}</div>}
      <div className="aim-xfoot">
        <span>{catLabel(s.category)}</span>
        <em>{s.from_catalog ? "from the catalog" : ".claude/skills"}</em>
      </div>
    </div>
  );
}

function CatalogCard({ c, project, inProject, inSystem, busy, onToggle }: {
  c: CatalogSkill;
  project: string | null;
  inProject: boolean;
  inSystem: boolean;
  busy: string;
  onToggle: (scope: SkillScope, on: boolean) => void;
}) {
  const Icon = CAT_ICON[c.category] ?? Puzzle;
  return (
    <div className="aim-x" data-on={inProject || inSystem || undefined}>
      <div className="aim-xhd">
        <span className="aim-xic" style={{ color: CAT_COLOR[c.category] }}><Icon size={14} strokeWidth={1.7} aria-hidden /></span>
        <b title={c.id}>{c.name}</b>
        <span style={{ flex: 1, minWidth: 8 }} />
        {/* Sourced entries download the upstream SKILL.md verbatim — say so,
            and link the repo it comes from. */}
        {c.repo && (
          <a className="aim-xrepo" href={`https://github.com/${c.repo}`} target="_blank" rel="noreferrer" title={`view the source skill on GitHub — ${c.repo}`}>↗ {c.repo}</a>
        )}
      </div>
      <div className="aim-xhint clamp" title={c.description}>{c.description}</div>
      <div className="aim-xfoot">
        <span>{catLabel(c.category)}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="aim-xbtn" data-on={inProject || undefined} disabled={!project || busy === `project:${c.id}`}
          title={!project ? "open a session in a project first" : inProject ? "uninstall from the project" : "install to the project"}
          onClick={() => onToggle("project", inProject)}>{inProject ? "✓ Project" : "+ Project"}</button>
        <button type="button" className="aim-xbtn" data-on={inSystem || undefined} disabled={busy === `system:${c.id}`}
          title={inSystem ? "uninstall from this machine" : "install machine-wide"}
          onClick={() => onToggle("system", inSystem)}>{inSystem ? "✓ System" : "+ System"}</button>
      </div>
    </div>
  );
}

type Mode = "installed" | "catalog" | "plugins";

function SkillsGrid({ project }: { project: string | null }) {
  const [info, setInfo] = useState<SkillsInfo | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [mode, setMode] = useState<Mode>("installed");
  const [cat, setCat] = useState<SkillCategory | "all">("all");
  const [q, setQ] = useState("");
  // Skills we installed whose source repo has since changed — keyed "scope:id".
  const [stale, setStale] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    setInfo(null); setErr(""); setStale(new Set());
    void api.skills(project)
      .then((d) => { if (live) setInfo(d); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    // Follow the source repos: one sweep per open, results shown as ↻ Update
    // rather than applied behind your back.
    setChecking(true);
    void api.checkSkillUpdates(project)
      .then((d) => { if (live) setStale(new Set(d.outdated.map((o) => `${o.scope}:${o.id}`))); })
      .catch(() => { /* offline — just no badges */ })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [project]);

  async function toggle(id: string, scope: SkillScope, on: boolean) {
    if (busy) return;
    setBusy(`${scope}:${id}`); setErr("");
    try {
      // Both calls answer with the fresh installed lists, so no refetch.
      // Installing over an existing catalog skill is exactly what "update" is.
      const r = await (on ? api.removeSkill : api.installSkill)(id, scope, project);
      setInfo((p) => (p ? { ...p, project: r.project, system: r.system } : p));
      setStale((p) => { const n = new Set(p); n.delete(`${scope}:${id}`); return n; });
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy("");
  }

  /** Re-install every skill whose source moved on, one at a time. */
  async function updateAll() {
    for (const key of [...stale]) {
      const [scope, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      await toggle(id, scope as SkillScope, false);
    }
  }

  const inProject = useMemo(() => new Set((info?.project ?? []).map((s) => s.id)), [info]);
  const inSystem = useMemo(() => new Set((info?.system ?? []).map((s) => s.id)), [info]);
  const installed = (info?.project.length ?? 0) + (info?.system.length ?? 0);

  const needle = q.trim().toLowerCase();
  const shown = (info?.catalog ?? []).filter(
    (c) => (cat === "all" || c.category === cat)
      && (!needle || `${c.name} ${c.id} ${c.description}`.toLowerCase().includes(needle)),
  );
  const counts = (info?.catalog ?? []).reduce<Record<string, number>>(
    (a, c) => ({ ...a, [c.category]: (a[c.category] ?? 0) + 1 }), {});

  const group = (title: string, list: InstalledSkill[], scope: SkillScope) => (
    <>
      <div className="aim-glabel">{title} · {list.length}</div>
      {list.length === 0 ? (
        <div className="aim-hint">{scope === "project" && !project ? "No project selected." : "Nothing installed here yet."}</div>
      ) : (
        <div className="aim-xgrid">
          {list.map((s) => (
            <SkillCard key={s.id} s={s} busy={busy === `${scope}:${s.id}`}
              onRemove={s.from_catalog ? () => void toggle(s.id, scope, true) : null}
              onUpdate={stale.has(`${scope}:${s.id}`) ? () => void toggle(s.id, scope, false) : null} />
          ))}
        </div>
      )}
    </>
  );

  return (
    <>
      <div className="aim-sub" data-bar>
        <b>Skills</b>
        {info && <span className="aim-count">{installed} installed</span>}
        <span className="aim-hint">a SKILL.md the session can reach — here, or on this machine</span>
        <div className="set-seg2 aim-seg2" role="tablist">
          {(["installed", "catalog", "plugins"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} data-on={mode === m || undefined} onClick={() => setMode(m)}>
              {m === "installed" ? "Installed" : m === "plugins" ? "Plugins" : `Catalog · ${info?.catalog.length ?? 0}`}
            </button>
          ))}
        </div>
      </div>

      {mode === "plugins" && <div className="aim-plugins"><PluginsView /></div>}

      {mode !== "plugins" && err && <div className="aim-xerr" style={{ marginTop: 10 }}>{err}</div>}
      {mode !== "plugins" && !info && !err && <div className="aim-hint" style={{ marginTop: 10 }}>Loading skills…</div>}

      {info && mode === "installed" && (
        <>
          {checking && <div className="aim-hint" style={{ marginTop: 10 }}>Checking the source repos…</div>}
          {stale.size > 0 && (
            <div className="aim-note warn">
              <span style={{ flex: 1, minWidth: 0 }}>{stale.size} skill{stale.size > 1 ? "s" : ""} changed upstream</span>
              <button type="button" className="aim-xbtn warn" disabled={!!busy} onClick={() => void updateAll()}>↻ Update all</button>
            </div>
          )}
          {group("Project", info.project, "project")}
          {group("System", info.system, "system")}
        </>
      )}

      {info && mode === "catalog" && (
        <>
          <input className="aim-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalog…" />
          <div className="aim-chips">
            {CATS.map((c) => (
              <button key={c.k} type="button" className="aim-chipbtn" data-on={cat === c.k || undefined}
                style={{ "--c": c.k === "all" ? "var(--acc)" : CAT_COLOR[c.k] } as React.CSSProperties}
                onClick={() => setCat(c.k)}>
                {c.k !== "all" && <i />}{c.l} {c.k === "all" ? info.catalog.length : (counts[c.k] ?? 0)}
              </button>
            ))}
          </div>
          <div className="mscroll aim-catalog">
            <div className="aim-xgrid">
              {shown.map((c) => (
                <CatalogCard key={c.id} c={c} project={project} inProject={inProject.has(c.id)} inSystem={inSystem.has(c.id)}
                  busy={busy} onToggle={(scope, on) => void toggle(c.id, scope, on)} />
              ))}
            </div>
            {shown.length === 0 && <div className="aim-hint">No skill matches that filter.</div>}
          </div>
        </>
      )}
    </>
  );
}

/** The SKILLS fold of SETTINGS ▸ AI MANAGEMENT. */
export function SkillsFold({ project }: { project: string | null }) {
  return (
    <>
      <ExtrasGrid />
      <SkillsGrid project={project} />
    </>
  );
}
