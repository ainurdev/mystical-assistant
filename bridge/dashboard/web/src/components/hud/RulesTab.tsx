import { useCallback, useEffect, useState } from "react";
import { Activity as Pulse, ChevronRight, Eye, Layers, ListChecks, Plus, RotateCcw, ScrollText, ShieldCheck, X, type LucideIcon } from "lucide-react";
import {
  agentsNoRuleReaches, groupRules, levelTagOf, ruleReach, ruleWrite, type AgentRef, type RuleFields, type RuleLogRow, type RuleRow, type Scope,
} from "../../lib/agenttools";
import { at, isStaleBridge } from "../../lib/agenttoolsapi";
import { Switch } from "./SettingsModal";
import { StaleBridge } from "./AgentToolsBits";
import { AgentMark } from "./ToolGridTable";

/* SETTINGS ▸ Agent Tools ▸ Rules: bridge/rules.py's catalog at the picked level, as a ledger
   (.mystical/design-drafts/agent-tools-reimagine, B1): one line a rule, its own control on
   that line, how often it fired since the bridge started, and the long words a click away.
   A bar on top says when no Safety rule is on and turns them all on in one go. A switch or
   a field sets this level's pick for the whole rule, carrying the fields it read so a
   wider level's paths aren't lost; reset drops the pick and the next level decides. */

const GROUP_ICON: Record<string, LucideIcon> = { Safety: ShieldCheck, Quality: ListChecks, Context: Layers, Visibility: Eye };

function Paths({ value, onSave, busy }: { value: string[]; onSave: (paths: string[]) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim();
    if (!v) return;
    if (!value.includes(v)) onSave([...value, v]);
    setText("");
  };
  return (
    <div className="at-field">
      <span className="at-flabel">Paths</span>
      <div className="at-chips">
        {value.length === 0 && <span className="at-subnote">None yet: this rule protects nothing.</span>}
        {value.map((p) => (
          <span key={p} className="at-chip">
            <code>{p}</code>
            <button type="button" aria-label={`Remove ${p}`} disabled={busy} onClick={() => onSave(value.filter((x) => x !== p))}><X size={10} aria-hidden /></button>
          </span>
        ))}
        <span className="at-chipadd">
          <input className="ma-input" value={text} placeholder="add a path or *.pem" aria-label="Add a path" spellCheck={false}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button type="button" className="ma-link" disabled={busy || !text.trim()} onClick={add} aria-label="Add this path"><Plus size={12} aria-hidden /></button>
        </span>
      </div>
    </div>
  );
}

function Times({ value, onSave, busy, id }: { value: number; onSave: (n: number) => void; busy: boolean; id: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const n = Math.max(1, Math.min(100, Math.round(Number(text)) || value));
    setText(String(n));
    if (n !== value) onSave(n);
  };
  return (
    <div className="at-field at-inline">
      <input id={id} aria-label="Times in a row" className="ma-input at-num" type="number" min={1} max={100} value={text} disabled={busy}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
      <span className="at-subnote">in a row</span>
    </div>
  );
}

function Mode({ value, onSave, busy }: { value: string; onSave: (m: string) => void; busy: boolean }) {
  return (
    <div className="at-field at-inline">
      <div className="at-seg" role="radiogroup" aria-label="When it matches">
        {[{ v: "block", l: "Block" }, { v: "ask", l: "Ask me" }].map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={value === o.v} data-on={value === o.v || undefined} disabled={busy} onClick={() => { if (value !== o.v) onSave(o.v); }}>{o.l}</button>
        ))}
      </div>
    </div>
  );
}

function RuleLine({ rule, scope, agents, busy, fired, onWrite, onReset }: {
  rule: RuleRow; scope: Scope; agents: AgentRef[]; busy: boolean; fired: number;
  onWrite: (patch: { on?: boolean; fields?: RuleFields }) => void; onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const reach = ruleReach(rule, agents, scope.level);
  const here = rule.level === scope.level;
  const marks = agents.filter((a) => rule.agents.includes(a.id) || a.id === "claude" || a.id === "kimi");
  const paths = rule.fields.paths;
  return (
    <div className="at-rl" data-on={rule.on || undefined} data-open={open || undefined}>
      <div className="at-rlrow">
        <Switch on={rule.on} label={rule.name} onClick={() => { if (!busy) onWrite({ on: !rule.on }); }} />
        <b title={rule.about}>{rule.name}</b>
        <span className="at-rlags" title={`Acts on ${reach.acts}`}>{marks.map((a) => <AgentMark key={a.id} agent={a} dim={!rule.agents.includes(a.id)} />)}</span>
        <span className="at-rlfx">
          {rule.fields.mode !== undefined && <Mode value={rule.fields.mode} busy={busy} onSave={(mode) => onWrite({ fields: { mode } })} />}
          {rule.fields.times !== undefined && <Times id={`at-times-${rule.id}`} value={rule.fields.times} busy={busy} onSave={(times) => onWrite({ fields: { times } })} />}
          {paths !== undefined && (
            <button type="button" className="at-rlpaths" title="Edit the paths" onClick={() => setOpen(true)}>
              {paths.length ? paths.slice(0, 3).map((x) => <code key={x}>{x}</code>) : <span className="at-subnote">no paths yet</span>}
              {paths.length > 3 && <span className="at-subnote">+{paths.length - 3}</span>}
            </button>
          )}
        </span>
        <span className="at-rlfire" title="Times it blocked, asked or added something since the bridge started">{fired > 0 && <><Pulse size={11} aria-hidden />{fired} since start</>}</span>
        {here
          ? <button type="button" className="at-rltag" disabled={busy} title={`Set at ${rule.level} level. Click to reset: the next level decides`} onClick={onReset}>{levelTagOf(rule.level)}<RotateCcw size={9} aria-hidden /></button>
          : <span className="at-rltag" data-quiet title={rule.level ? `Set at ${rule.level} level` : "Nothing is picked at any level: its default"}>{levelTagOf(rule.level)}</span>}
        <button type="button" className="at-rlchev" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} what ${rule.name} does`} onClick={() => setOpen((o) => !o)}><ChevronRight size={13} aria-hidden /></button>
      </div>
      {open && (
        <div className="at-rlmore">
          <p className="at-ruleabout">{rule.about}</p>
          <div className="at-rulewho"><span>Acts on</span><b>{reach.acts}</b></div>
          {reach.notes.map((n) => <div key={n} className="at-rulenote">{n}</div>)}
          {paths !== undefined && <Paths value={paths} busy={busy} onSave={(p) => onWrite({ fields: { paths: p } })} />}
        </div>
      )}
    </div>
  );
}

function Activity({ session, names, chatName, onOpenChat, rows, error, load }: {
  session: string | null; names: Map<string, string>; chatName: (id: string) => string | undefined; onOpenChat: (id: string) => void;
  rows: RuleLogRow[] | null; error: string | null; load: () => void;
}) {
  return (
    <section className="at-log" data-sec="RECENT ACTIVITY">
      <div className="at-subhead">
        <b>Recent activity</b>
        <span className="at-subnote">{session ? "In this chat, since the bridge started." : "Every chat, since the bridge started."}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ma-link" onClick={load}>refresh</button>
      </div>
      {error && <div className="ma-set-err" role="alert">Couldn&apos;t read it: {error} <button type="button" className="ma-link" onClick={load}>try again</button></div>}
      {!rows && !error && <div className="ma-set-note" role="status">Reading what rules did…</div>}
      {rows?.length === 0 && (
        <div className="at-emptybox"><ScrollText size={18} strokeWidth={1.4} aria-hidden /><span>No rule has fired yet. When one blocks, asks or adds something, it shows here and in the chat.</span></div>
      )}
      {rows && rows.length > 0 && (
        <div className="at-logscroll">
          <table className="at-logtbl">
            <thead><tr><th scope="col">Time</th><th scope="col">Rule</th><th scope="col">Tool</th><th scope="col">Decision</th><th scope="col">Chat</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.at}:${i}`} title={r.why || undefined}>
                  <td>{new Date(r.at * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{names.get(r.rule) ?? r.rule}</td>
                  <td><code>{r.tool || "—"}</code></td>
                  <td data-d={r.decision === "blocked" ? "blocked" : undefined}>{r.decision}</td>
                  <td><button type="button" className="ma-link at-chatlink" title={chatName(r.session) ?? r.session} onClick={() => onOpenChat(r.session)}>{chatName(r.session) ?? "open the chat"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function RulesTab({ scope, agents, chatName, onOpenChat }: {
  scope: Scope; agents: AgentRef[]; chatName: (id: string) => string | undefined; onOpenChat: (id: string) => void;
}) {
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    setRules(null);
    at.rules(scope).then((r) => setRules(r.rules), (e: Error) => setError(e.message));
  }, [scope]);
  useEffect(() => { load(); }, [load]);
  const session = scope.level === "chat" ? scope.session : null;
  const [log, setLog] = useState<RuleLogRow[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const loadLog = useCallback(() => {
    setLogError(null);
    at.ruleLog(session).then((r) => setLog(r.rows), (e: Error) => setLogError(e.message));
  }, [session]);
  useEffect(() => { loadLog(); }, [loadLog]);
  const send = async (id: string, on: boolean | null, fields?: RuleFields) => {
    setBusy(id);
    setSaveError(null);
    try {
      const r = await at.rule(scope, id, on, fields);
      setRules(r.rules);
    } catch (e) {
      setSaveError({ id, text: (e as Error).message });
    } finally { setBusy(null); }
  };
  if (isStaleBridge(error)) return <StaleBridge what="the rules" />;
  if (error) return <div className="ma-set-err" role="alert">Couldn&apos;t read the rules: {error} <button type="button" className="ma-link" onClick={load}>try again</button></div>;
  if (!rules) return <div className="ma-set-note" role="status">Reading the rules…</div>;
  const names = new Map(rules.map((r) => [r.id, r.name]));
  const unreached = agentsNoRuleReaches(rules, agents);
  const fired = (id: string) => log?.filter((x) => x.rule === id).length ?? 0;
  const safety = rules.filter((r) => r.group === "Safety");
  const safetyOff = safety.length > 0 && !safety.some((r) => r.on);
  const turnOnSafety = async () => {
    for (const r of safety) { const w = ruleWrite(r, { on: true }); await send(w.id, w.on, w.fields); }
  };
  return (
    <div className="at-rules">
      {unreached.length > 0 && <div className="at-colnote"><b>{unreached.map((a) => a.label).join(", ")}</b>{unreached.length === 1 ? "has" : "have"} no hooks Mystical can use, so no rule acts there.</div>}
      {rules.length > 0 && (
        <div className="at-rlsum" data-warn={safetyOff || undefined}>
          <ShieldCheck size={15} aria-hidden />
          <span><b>{rules.filter((r) => r.on).length} of {rules.length}</b> rules on{safetyOff && <> · <b>no Safety rule</b> is on: an agent can still force-push or <code>rm -rf</code>.</>}</span>
          <span style={{ flex: 1 }} />
          {safetyOff && <button type="button" className="at-btn" disabled={!!busy} onClick={() => void turnOnSafety()}>Turn on Safety</button>}
        </div>
      )}
      {rules.length === 0 && <div className="at-emptybox"><ScrollText size={18} strokeWidth={1.4} aria-hidden /><span>This bridge lists no rules.</span></div>}
      {groupRules(rules).map((g) => (
        <section key={g.group} className="at-rulegroup">
          <h3>{(() => { const I = GROUP_ICON[g.group] ?? ScrollText; return <I size={13} aria-hidden />; })()}{g.group}<small>{g.rows.filter((r) => r.on).length} of {g.rows.length} on</small></h3>
          <div className="at-rlcard">
          {g.rows.map((r) => (
            <div key={r.id}>
              <RuleLine rule={r} scope={scope} agents={agents} busy={busy === r.id} fired={fired(r.id)}
                onWrite={(patch) => { const w = ruleWrite(r, patch); void send(w.id, w.on, w.fields); }}
                onReset={() => void send(r.id, null)} />
              {saveError?.id === r.id && <div className="ma-set-err" role="alert">{saveError.text}</div>}
            </div>
          ))}
          </div>
        </section>
      ))}
      <Activity session={session} names={names} chatName={chatName} onOpenChat={onOpenChat} rows={log} error={logError} load={loadLog} />
    </div>
  );
}
