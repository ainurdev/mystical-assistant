import { useEffect, useMemo, useState } from "react";
import { api, type CatalogSkill, type InstalledSkill, type SkillCategory, type SkillScope, type SkillsInfo } from "../../api";

/* SKILLS — what's installed as a Claude Code skill (a SKILL.md under
   .claude/skills/) plus the built-in catalog you can install from.

   Two surfaces share this body:
     · the right sidebar (SkillsPanel) — project AND system, installs to either;
     · the ANALYZE modal (SkillsTab)   — project only, installs to the project.  */

const CATS: { k: SkillCategory | "all"; l: string }[] = [
  { k: "all", l: "ALL" },
  { k: "development", l: "DEV" },
  { k: "design", l: "DESIGN" },
  { k: "writing", l: "WRITING" },
  { k: "testing", l: "TESTING" },
  { k: "workflow", l: "WORKFLOW" },
  { k: "other", l: "OTHER" },
];

const CAT_COLOR: Record<SkillCategory, string> = {
  development: "var(--acc)",
  design: "var(--purple)",
  writing: "var(--info)",
  testing: "var(--ok)",
  workflow: "var(--warn)",
  other: "var(--txd)",
};

const LABEL = { fontSize: 8.5, letterSpacing: 1.5, color: "var(--txl)" } as const;

/** One installed skill — name, description, and (catalog skills only) remove. */
function InstalledRow({ s, onRemove, onUpdate, busy }: {
  s: InstalledSkill;
  onRemove: (() => void) | null;
  onUpdate: (() => void) | null; // set when the source repo has moved on
  busy: boolean;
}) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 9px", marginBottom: 5, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: hov ? "color-mix(in srgb, var(--acc) 5%, transparent)" : "color-mix(in srgb, var(--panel2) 35%, transparent)" }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: CAT_COLOR[s.category], flex: "none", marginTop: 5 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
        {s.description && (
          <div style={{ fontSize: 9.5, color: "var(--txd)", marginTop: 3, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.description}</div>
        )}
      </div>
      {onUpdate && (
        <button onClick={onUpdate} disabled={busy} title="the source repo changed — pull the new version"
          style={{ appearance: "none", cursor: busy ? "default" : "pointer", border: "1px solid var(--warn)", background: "color-mix(in srgb, var(--warn) 14%, transparent)", color: "var(--warn)", fontFamily: "inherit", fontSize: 8.5, letterSpacing: 1, padding: "4px 6px", flex: "none", marginTop: 1, opacity: busy ? 0.45 : 1 }}>↻ UPDATE</button>
      )}
      {onRemove ? (
        <button onClick={onRemove} disabled={busy} title="uninstall"
          style={{ appearance: "none", cursor: busy ? "default" : "pointer", border: "1px solid color-mix(in srgb, var(--err) 25%, transparent)", background: "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: 10, lineHeight: 1, padding: "4px 6px", flex: "none", opacity: busy ? 0.4 : hov ? 1 : 0.5 }}>✕</button>
      ) : (
        <span title="hand-written skill — edit it on disk" style={{ ...LABEL, flex: "none", marginTop: 3 }}>OWN</span>
      )}
    </div>
  );
}

/** Install/uninstall toggle for one catalog entry in one scope. */
function ScopeBtn({ label, on, disabled, onClick }: {
  label: string; on: boolean; disabled: boolean; onClick: () => void;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      title={on ? `uninstall from ${label.toLowerCase()}` : `install to ${label.toLowerCase()}`}
      style={{
        appearance: "none", cursor: disabled ? "default" : "pointer", flex: "none", whiteSpace: "nowrap",
        border: `1px solid ${on ? "var(--ok)" : hov ? "var(--acc)" : "color-mix(in srgb, var(--acc) 22%, transparent)"}`,
        background: on ? "color-mix(in srgb, var(--ok) 12%, transparent)" : hov ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
        color: on ? "var(--ok)" : "var(--txm)", opacity: disabled ? 0.45 : 1,
        fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "4px 7px",
      }}
    >{on ? "✓ " : "+ "}{label}</button>
  );
}

export function SkillsView({ project, system }: { project: string | null; system: boolean }) {
  const [info, setInfo] = useState<SkillsInfo | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [mode, setMode] = useState<"installed" | "catalog">("installed");
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
    // Follow the source repos: one sweep per open, results shown as ↻ UPDATE
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
      if (scope === "system" && !system) continue; // modal never touches system
      await toggle(id, scope as SkillScope, false);
    }
  }

  const inProject = useMemo(() => new Set((info?.project ?? []).map((s) => s.id)), [info]);
  const inSystem = useMemo(() => new Set((info?.system ?? []).map((s) => s.id)), [info]);
  // The modal never shows or touches system skills, so it must not count them.
  const visibleStale = [...stale].filter((k) => system || k.startsWith("project:")).length;

  const needle = q.trim().toLowerCase();
  const shown = (info?.catalog ?? []).filter(
    (c) => (cat === "all" || c.category === cat)
      && (!needle || `${c.name} ${c.id} ${c.description}`.toLowerCase().includes(needle)),
  );
  const counts = (info?.catalog ?? []).reduce<Record<string, number>>(
    (a, c) => ({ ...a, [c.category]: (a[c.category] ?? 0) + 1 }), {});

  const section = (title: string, list: InstalledSkill[], scope: SkillScope) => (
    <>
      <div style={{ ...LABEL, display: "flex", alignItems: "center", gap: 7, margin: "0 0 7px" }}>
        <span>{title} · {list.length}</span>
        <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "2px 2px 10px" }}>
          {scope === "project" && !project ? "No project selected." : "Nothing installed here yet."}
        </div>
      ) : (
        <div style={{ marginBottom: 11 }}>
          {list.map((s) => (
            <InstalledRow key={s.id} s={s} busy={busy === `${scope}:${s.id}`}
              onRemove={s.from_catalog ? () => void toggle(s.id, scope, true) : null}
              onUpdate={stale.has(`${scope}:${s.id}`) ? () => void toggle(s.id, scope, false) : null} />
          ))}
        </div>
      )}
    </>
  );

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      {/* installed ↔ catalog */}
      <div style={{ display: "flex", gap: 3, border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", background: "color-mix(in srgb, var(--panel2) 30%, transparent)", padding: 3, marginBottom: 11 }}>
        {(["installed", "catalog"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            style={{ flex: 1, appearance: "none", cursor: "pointer", border: 0, background: mode === m ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent", color: mode === m ? "var(--txb)" : "var(--txf)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: 7, transition: "all .15s ease" }}
          >{m === "installed" ? "INSTALLED" : `CATALOG · ${info?.catalog.length ?? 0}`}</button>
        ))}
      </div>

      {err && <div style={{ fontSize: 10, color: "var(--err)", marginBottom: 9 }}>{err}</div>}
      {!info && !err && <div style={{ fontSize: 10.5, color: "var(--txl)" }}>Loading skills…</div>}

      {info && mode === "installed" && (
        <>
          {checking && (
            <div style={{ ...LABEL, marginBottom: 9 }}>CHECKING SOURCE REPOS…</div>
          )}
          {visibleStale > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 10, border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: "var(--warn)" }}>
                {visibleStale} skill{visibleStale > 1 ? "s" : ""} changed upstream
              </span>
              <button onClick={() => void updateAll()} disabled={!!busy}
                style={{ appearance: "none", cursor: busy ? "default" : "pointer", flex: "none", border: "1px solid var(--warn)", background: "color-mix(in srgb, var(--warn) 16%, transparent)", color: "var(--warn)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "5px 9px", opacity: busy ? 0.45 : 1 }}
              >↻ UPDATE ALL</button>
            </div>
          )}
          {section("PROJECT", info.project, "project")}
          {system && section("SYSTEM", info.system, "system")}
        </>
      )}

      {info && mode === "catalog" && (
        <>
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="search skills…"
            style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "6px 8px", marginBottom: 8 }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
            {CATS.map((c) => {
              const on = cat === c.k;
              const tint = c.k === "all" ? "var(--acc)" : CAT_COLOR[c.k];
              return (
                <button key={c.k} onClick={() => setCat(c.k)}
                  style={{ appearance: "none", cursor: "pointer", border: `1px solid ${on ? tint : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, background: on ? `color-mix(in srgb, ${tint} 12%, transparent)` : "transparent", color: on ? "var(--txb)" : "var(--txd)", fontFamily: "inherit", fontSize: 8.5, letterSpacing: 1, padding: "4px 7px" }}
                >{c.l} {c.k === "all" ? (info.catalog.length) : (counts[c.k] ?? 0)}</button>
              );
            })}
          </div>
          <div className="mscroll" style={{ maxHeight: 420, overflowY: "auto", paddingRight: 2 }}>
            {shown.map((c: CatalogSkill) => (
              <div key={c.id}
                style={{ display: "flex", gap: 9, alignItems: "flex-start", flexWrap: "wrap", padding: "9px 10px", marginBottom: 5, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 30%, transparent)" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: CAT_COLOR[c.category], flex: "none", marginTop: 5 }} />
                <div style={{ flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: 11.5, color: "var(--txb)" }}>{c.name}</div>
                  <div style={{ fontSize: 9.5, color: "var(--txd)", marginTop: 3, lineHeight: 1.5 }}>{c.description}</div>
                  {/* Sourced entries download the upstream SKILL.md verbatim —
                      say so, and link the repo it comes from. */}
                  {c.repo && (
                    <a href={`https://github.com/${c.repo}`} target="_blank" rel="noreferrer"
                      onClick={(e) => e.stopPropagation()} title="view the source skill on GitHub"
                      style={{ display: "inline-block", marginTop: 5, fontSize: 8.5, letterSpacing: 0.5, color: "var(--txf)", textDecoration: "none", borderBottom: "1px dotted color-mix(in srgb, var(--acc) 30%, transparent)" }}
                    >↗ {c.repo}</a>
                  )}
                </div>
                <div style={{ display: "flex", gap: 5, flex: "none", marginTop: 1 }}>
                  <ScopeBtn label="PROJECT" on={inProject.has(c.id)} disabled={!project || busy === `project:${c.id}`}
                    onClick={() => void toggle(c.id, "project", inProject.has(c.id))} />
                  {system && (
                    <ScopeBtn label="SYSTEM" on={inSystem.has(c.id)} disabled={busy === `system:${c.id}`}
                      onClick={() => void toggle(c.id, "system", inSystem.has(c.id))} />
                  )}
                </div>
              </div>
            ))}
            {shown.length === 0 && (
              <div style={{ fontSize: 10.5, color: "var(--txl)", padding: "4px 2px" }}>No skill matches that filter.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** ANALYZE modal tab — project scope only. */
export function SkillsTab({ project, name }: { project: string; name: string }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <span style={{ ...LABEL, letterSpacing: 1.5 }}>SKILLS ·</span>
        <span style={{ fontSize: 12, color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: "var(--txd)" }}>.claude/skills</span>
      </div>
      <SkillsView project={project} system={false} />
    </div>
  );
}

/** Right-sidebar panel — project AND system, installs to either. */
export function SkillsPanel({ project }: { project: string | null }) {
  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 50%, transparent)", flex: "none" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "var(--txl)" }}>SKILLS</span>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--acc)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {project ? project.split("/").pop() : "NO PROJECT"}
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))", transformOrigin: "left", animation: "drawline .7s ease both .16s" }} />
      <div style={{ padding: 11 }}>
        <SkillsView project={project} system />
      </div>
    </div>
  );
}
