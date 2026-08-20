import { useEffect, useState } from "react";
import { api, type InstalledSkill } from "../../api";

/* DESIGN tab — link this repo to a Claude Design project, then pull its tokens
   and components down as a project skill, or push local drift back. Lives in
   the per-project modal (moved out of SETTINGS: the link is per-repo state, so
   it belongs with the repo). Every button only composes a prompt
   (api.designPrompt) and queues it into the open session via onFeed — nothing
   here runs a tool on its own. */

// bridge/skills.py stamps every SKILLS entry with `from_design`/`design_project`
// (a pulled design system's own marker), but api.ts's InstalledSkill predates
// that marker — widen it locally here rather than touch the shared bindings.
type DesignSkill = InstalledSkill & { from_design: boolean; design_project: string | null };

const NOTE: React.CSSProperties = {
  fontSize: "var(--t95)", color: "var(--txl)", lineHeight: 1.7,
};
const CARD: React.CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
  background: "color-mix(in srgb, var(--panel) 55%, transparent)",
  padding: "12px 13px",
};
const KEY_TX: React.CSSProperties = { fontSize: "var(--t10)", letterSpacing: 1, color: "var(--txd)" };

function Btn({ children, onClick, disabled }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none", cursor: disabled ? "default" : "pointer",
        border: "1px solid color-mix(in srgb, var(--acc) 24%, transparent)",
        background: hov && !disabled ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
        color: disabled ? "var(--txd)" : "var(--tx)",
        fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1,
        padding: "4px 9px", opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** One state at a time, like the SETTINGS original: STATUS→LINK, LINKED→PULL,
 *  SKILL→SYNC/RE-PULL. */
function StateRow({ label, desc, children }: {
  label: string;
  desc: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={KEY_TX}>{label}</span>
        <span style={{ flex: 1, minWidth: 8 }} />
        {children}
      </div>
      <div style={{ ...NOTE, marginTop: 4 }}>{desc}</div>
    </div>
  );
}

export function DesignTab({ project, onFeed }: {
  project: string;
  onFeed: (texts: string[]) => void;
}) {
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const [skill, setSkill] = useState<DesignSkill | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<"link" | "pull" | "push" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setReady(false);
    void (async () => {
      try {
        const [settings, info] = await Promise.all([
          api.projectSettings({ project }),
          api.skills(project),
        ]);
        if (!alive) return;
        setLinkedId(settings.design_project);
        const pulled = (info.project as DesignSkill[]).find(
          (s) => s.from_design && s.design_project === settings.design_project,
        );
        setSkill(pulled ?? null);
      } catch {
        /* leave the UNLINKED default rather than blocking the tab on it */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, [project]);

  async function act(kind: "link" | "pull" | "push", name?: string) {
    setBusy(kind);
    setErr(null);
    try {
      const res = await api.designPrompt({ project }, kind, name);
      if (res.error) setErr(res.error);
      else if (res.prompt) onFeed([res.prompt]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not reach the bridge");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ ...NOTE, marginBottom: 12 }}>
        LINK, PULL and SYNC compose a prompt and queue it into the open session — nothing runs
        until you send it. A pull lands under{" "}
        <span style={{ color: "var(--txd)" }}>.claude/skills/</span> as a project skill, which
        Claude Code loads on its own per prompt.
      </div>
      <div style={CARD}>
        {!ready ? (
          <div style={NOTE}>Reading…</div>
        ) : !linkedId ? (
          <StateRow label="STATUS" desc="Not linked to a Claude Design project.">
            <Btn onClick={() => void act("link")} disabled={busy !== null}>
              {busy === "link" ? "…" : "LINK"}
            </Btn>
          </StateRow>
        ) : !skill ? (
          <StateRow
            label="LINKED"
            desc={<span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{linkedId}</span>}
          >
            <Btn onClick={() => void act("pull")} disabled={busy !== null}>
              {busy === "pull" ? "…" : "PULL"}
            </Btn>
          </StateRow>
        ) : (
          <StateRow label="SKILL" desc={skill.name || skill.id}>
            <Btn onClick={() => void act("push")} disabled={busy !== null}>
              {busy === "push" ? "…" : "SYNC"}
            </Btn>
            <Btn onClick={() => void act("pull", skill.id)} disabled={busy !== null}>
              {busy === "pull" ? "…" : "RE-PULL"}
            </Btn>
          </StateRow>
        )}
        {err && <div style={{ ...NOTE, color: "var(--err)", marginTop: 8 }}>{err}</div>}
      </div>
    </div>
  );
}
