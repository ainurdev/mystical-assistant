import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, Pencil, Plus, TerminalSquare, Trash2, TriangleAlert } from "lucide-react";
import { copyTargets, hookAgents, hookProblem, type AgentRef, type HookListing, type HookRow, type Scope } from "../../lib/agenttools";
import { at, isStaleBridge } from "../../lib/agenttoolsapi";
import { askConfirm } from "../ui/Ask";
import { StaleBridge } from "./AgentToolsBits";

/* SETTINGS ▸ Agent Tools ▸ Hooks: bridge/hooks_config.py. Yours are real shell commands in
   each agent's own config file, so they fire in a terminal too. Mystical's own run per turn
   and exist in no file, so they're only described. What the route refuses reads as it said
   it: the row or the form shows its sentence, unchanged. */

interface Draft { id?: string; agent: string; scope: string; event: string; matcher: string; command: string; timeout: string }

function HookForm({ draft, list, agents, hasProject, onCancel, onSave }: {
  draft: Draft; list: HookListing; agents: AgentRef[]; hasProject: boolean;
  onCancel: () => void; onSave: (d: Draft) => Promise<string | null>;
}) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!draft.id;
  const events = list.events[d.agent] ?? [];
  const blocks = new Set(list.can_block[d.agent] ?? []);
  const set = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setError(null); };
  const pickAgent = (agent: string) => {
    const has = (list.events[agent] ?? []).includes(d.event);
    set({ agent, scope: agent === "claude" ? d.scope : "user", event: has ? d.event : "" });
  };
  const submit = async () => {
    const problem = hookProblem(d);
    if (problem) { setError(problem); return; }
    setBusy(true);
    const refused = await onSave(d);
    setBusy(false);
    if (refused) setError(refused);
  };
  const userOnly = d.agent !== "claude";
  return (
    <form className="at-hookform" aria-label={editing ? "Edit a hook" : "Add a hook"} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="at-formgrid">
        <label><span>Agent</span>
          {editing ? <output>{agents.find((a) => a.id === d.agent)?.label ?? d.agent}</output> : (
            <select className="ma-input" value={d.agent} onChange={(e) => pickAgent(e.target.value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          )}
        </label>
        <div className="at-formfield"><span id="at-scope-l">Scope</span>
          {editing ? <output>{d.scope === "user" ? "Every project" : "This project"}</output> : (
            <div className="at-seg" role="radiogroup" aria-labelledby="at-scope-l">
              <button type="button" role="radio" aria-checked={d.scope === "user"} data-on={d.scope === "user" || undefined} onClick={() => set({ scope: "user" })}>User</button>
              <button type="button" role="radio" aria-checked={d.scope === "project"} data-on={d.scope === "project" || undefined}
                disabled={userOnly || !hasProject}
                title={userOnly ? "Kimi has no project hooks: it only reads its user-level config." : !hasProject ? "Pick a project above first." : undefined}
                onClick={() => set({ scope: "project" })}>Project</button>
            </div>
          )}
          {!editing && userOnly && <small>Kimi has no project hooks: it only reads its user-level config.</small>}
        </div>
        <label><span>Event</span>
          <select className="ma-input" value={d.event} onChange={(e) => set({ event: e.target.value })}>
            <option value="">Pick an event</option>
            <optgroup label="Can block">{events.filter((x) => blocks.has(x)).map((x) => <option key={x} value={x}>{x}</option>)}</optgroup>
            <optgroup label="Only runs">{events.filter((x) => !blocks.has(x)).map((x) => <option key={x} value={x}>{x}</option>)}</optgroup>
          </select>
          <small>{d.event ? (blocks.has(d.event) ? "This one can block what's about to happen." : "This one runs and can't stop anything.") : "Those under Can block can stop what's about to happen."}</small>
        </label>
        <label><span>Matcher</span>
          <input className="ma-input" value={d.matcher} placeholder="Bash, or blank for everything" spellCheck={false} onChange={(e) => set({ matcher: e.target.value })} />
        </label>
        <label><span>Timeout, seconds</span>
          <input className="ma-input at-num" inputMode="numeric" value={d.timeout} placeholder="its default" onChange={(e) => set({ timeout: e.target.value })} />
        </label>
        <label className="at-wide"><span>Command, one line</span>
          <input className="ma-input at-cmd" value={d.command} placeholder="./scripts/check.sh" spellCheck={false} onChange={(e) => set({ command: e.target.value })} />
        </label>
      </div>
      {error && <div className="ma-set-err" role="alert">{error}</div>}
      <div className="at-formfoot">
        <button type="button" className="at-btn" data-quiet onClick={onCancel}>Cancel</button>
        <button type="submit" className="at-btn" data-primary disabled={busy}>{busy ? "Saving…" : editing ? "Save the hook" : "Add the hook"}</button>
      </div>
    </form>
  );
}

function HookLine({ h, list, agents, onEdit, onRemove, onCopy }: {
  h: HookRow; list: HookListing; agents: AgentRef[]; onEdit: () => void; onRemove: () => void; onCopy: (a: AgentRef) => void;
}) {
  return (
    <div className="at-hook">
      <div className="at-hookhead">
        <b>{h.event}</b>
        {h.can_block && <span className="ma-tag" data-tone="warn">CAN BLOCK</span>}
        <span className="ma-tag">{h.scope === "user" ? "USER" : "PROJECT"}</span>
        {h.type !== "command" && <span className="ma-tag">{h.type.toUpperCase()}</span>}
        {h.matcher && <span className="at-subnote">on <code>{h.matcher}</code></span>}
        {h.timeout != null && <span className="at-subnote">{h.timeout}s</span>}
        <span style={{ flex: 1 }} />
        {copyTargets(h, list, agents).map((a) => (
          <button key={a.id} type="button" className="ma-link" title={`Into ${a.label}'s user config`} onClick={() => onCopy(a)}>copy to {a.label}</button>
        ))}
        {h.editable && <button type="button" className="ma-link" onClick={onEdit}><Pencil size={10} aria-hidden />edit</button>}
        <button type="button" className="ma-link" data-danger onClick={onRemove}><Trash2 size={10} aria-hidden />remove</button>
      </div>
      <code className="at-hookcmd" title={h.command}>{h.command}</code>
    </div>
  );
}

export function HooksTab({ scope, agents }: { scope: Scope; agents: AgentRef[] }) {
  const [list, setList] = useState<HookListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [form, setForm] = useState<Draft | null>(null);
  const load = useCallback(() => {
    setError(null);
    setList(null);
    at.hooks(scope).then(setList, (e: Error) => setError(e.message));
  }, [scope]);
  useEffect(() => { load(); }, [load]);
  const who = useMemo(() => (list ? hookAgents(list, agents) : []), [list, agents]);
  const hasProject = !!(scope.project || (scope.level === "chat" && scope.session));

  const act = async (w: Parameters<typeof at.hook>[1]) => {
    setRowError(null);
    try { setList(await at.hook(scope, w)); } catch (e) { setRowError((e as Error).message); }
  };
  const save = async (d: Draft): Promise<string | null> => {
    const timeout = d.timeout.trim() ? Number(d.timeout) : null;
    try {
      const next = await at.hook(scope, d.id
        ? { action: "edit", id: d.id, event: d.event, matcher: d.matcher, command: d.command, timeout }
        : { action: "add", agent: d.agent, scope: d.scope, event: d.event, matcher: d.matcher, command: d.command, timeout });
      setList(next);
      setForm(null);
      return null;
    } catch (e) { return (e as Error).message; }
  };
  const remove = async (h: HookRow) => {
    if (await askConfirm(`Remove this ${h.event} hook? ${h.command}`, { ok: "Remove", danger: true })) void act({ action: "remove", id: h.id });
  };

  if (isStaleBridge(error)) return <StaleBridge what="hooks" />;
  if (error) return <div className="ma-set-err" role="alert">Couldn&apos;t read the hooks: {error} <button type="button" className="ma-link" onClick={load}>try again</button></div>;
  if (!list) return <div className="ma-set-note" role="status">Reading each agent&apos;s config…</div>;

  const startAdd = () => setForm({ agent: who[0]?.id ?? "claude", scope: "user", event: "", matcher: "", command: "", timeout: "" });
  return (
    <div className="at-hooks" data-sec="HOOKS">
      <div className="at-warn" role="note">
        <TriangleAlert size={14} aria-hidden />
        <span><b>A hook is a shell command that runs on matching tool calls.</b> It runs on this machine with your permissions, and it lives in the agent&apos;s own config, so it fires in a terminal too. Add only what you&apos;d run yourself. Most of what people want from a hook is already a <em>rule</em>.</span>
      </div>

      <section>
        <div className="at-subhead"><Lock size={12} aria-hidden /><b>Mystical&apos;s own</b><span className="at-subnote">They run per turn and exist in no file, so they can&apos;t be changed here.</span></div>
        <div className="at-ownlist">
          {list.own.map((h) => (
            <div key={`${h.name}:${h.agent}`} className="at-own">
              <div><b>{h.name}</b><span className="at-subnote">{h.event} · {h.agent}</span></div>
              <p>{h.about}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="at-subhead">
          <TerminalSquare size={12} aria-hidden /><b>Yours</b>
          <span style={{ flex: 1 }} />
          {!form && <button type="button" className="at-btn" onClick={startAdd}><Plus size={12} aria-hidden />Add a hook</button>}
        </div>
        {rowError && <div className="ma-set-err" role="alert">{rowError}</div>}
        {form && !form.id && <HookForm draft={form} list={list} agents={who} hasProject={hasProject} onCancel={() => setForm(null)} onSave={save} />}
        {who.map((a) => {
          const rows = list.hooks.filter((h) => h.agent === a.id);
          return (
            <div key={a.id} className="at-hookagent">
              <h3>{a.label}<small>{a.id === "claude" ? "~/.claude/settings.json, and .claude/settings.json in a project" : a.id === "kimi" ? "config.toml under Kimi's home, user level only" : ""}</small></h3>
              {rows.length === 0 && <div className="at-empty-line">No hooks of yours in {a.label}.</div>}
              {rows.map((h, i) => (
                form?.id === h.id ? (
                  <HookForm key={h.id} draft={form} list={list} agents={who} hasProject={hasProject} onCancel={() => setForm(null)} onSave={save} />
                ) : (
                  <HookLine key={`${h.id}:${i}`} h={h} list={list} agents={who}
                    onEdit={() => setForm({ id: h.id, agent: h.agent, scope: h.scope, event: h.event, matcher: h.matcher, command: h.command, timeout: h.timeout == null ? "" : String(h.timeout) })}
                    onRemove={() => void remove(h)}
                    onCopy={(to) => void act({ action: "copy", id: h.id, agent: to.id })} />
                )
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}
