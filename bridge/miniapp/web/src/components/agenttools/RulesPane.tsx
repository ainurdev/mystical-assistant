import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  ago, clampTimes, control, levelWord, parsePaths, ruleCell, ruleFieldsLine, ruleGroups, ruleHasFields,
  type Level, type Rule, type RuleFields, type ToolScope,
} from "../../lib/agenttools";
import { providerName } from "../../lib/multi";
import { Btn, Empty, Fail, Loading, RowError, Sheet, StateTag, Sw, useAct, messageOf } from "./parts";

/* RULES: the catalog's groups, toggled at the level picked at the top.

   A level's pick replaces that level's fields whole (rules.set_rule), so a toggle sends the
   fields the rule has now: leaving them out would quietly reset a rule's protected paths to
   nothing. Saving fields keeps the rule's on/off for the same reason in reverse. */

function FieldsSheet({ rule, level, scope, onDone, onClose }: {
  rule: Rule; level: Level; scope: ToolScope; onDone: () => Promise<unknown>; onClose: () => void;
}) {
  const f = rule.fields;
  const [paths, setPaths] = useState((f.paths ?? []).join("\n"));
  const [mode, setMode] = useState(f.mode ?? "block");
  const [times, setTimes] = useState(String(f.times ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const fields: RuleFields = {};
    if (f.paths) fields.paths = parsePaths(paths);
    if (f.mode) fields.mode = mode;
    if (f.times !== undefined) fields.times = clampTimes(times, f.times);
    setBusy(true);
    setError(null);
    try {
      await api.ruleSet(scope, level, rule.id, rule.on, fields);
      await onDone();
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={rule.name} onClose={onClose} footer={
      <>
        <Btn full primary disabled={busy} onClick={() => void save()}>{busy ? "SAVING…" : `SAVE AT ${levelWord(level).toUpperCase()}`}</Btn>
        <Btn full disabled={busy} onClick={onClose}>CANCEL</Btn>
      </>
    }>
      <div className="space-y-3">
        <div className="atv-sub">{rule.about}</div>
        {f.mode !== undefined && (
          <div className="space-y-1.5">
            <div className="sset-head">When it matches</div>
            <div className="sseg atv-seg" role="group" aria-label="When it matches">
              <button type="button" aria-pressed={mode === "block"} onClick={() => setMode("block")}>Block</button>
              <button type="button" aria-pressed={mode === "ask"} onClick={() => setMode("ask")}>Ask me</button>
            </div>
            <div className="atv-sub">Only Claude can ask. Every other agent is blocked either way.</div>
          </div>
        )}
        {f.paths !== undefined && (
          <div className="space-y-1.5">
            <label htmlFor="at-paths" className="sset-head block">Paths, one per line</label>
            <textarea id="at-paths" value={paths} onChange={(e) => setPaths(e.target.value)} rows={6}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} className="atv-input atv-area" placeholder={".env\n*.pem\nmigrations/"} />
            <div className="atv-sub">A * matches within one folder. A trailing / means everything inside. 50 at most.</div>
          </div>
        )}
        {f.times !== undefined && (
          <div className="space-y-1.5">
            <label htmlFor="at-times" className="sset-head block">Failures in a row</label>
            <input id="at-times" type="number" inputMode="numeric" min={1} max={100} value={times}
              onChange={(e) => setTimes(e.target.value)} className="atv-input" />
            <div className="atv-sub">From 1 to 100.</div>
          </div>
        )}
        <RowError text={error ?? undefined} />
      </div>
    </Sheet>
  );
}

function RuleRow({ rule, level, scope, refresh }: { rule: Rule; level: Level; scope: ToolScope; refresh: () => Promise<unknown> }) {
  const [edit, setEdit] = useState(false);
  const { pending, errors, run } = useAct(refresh);
  const going = pending.it;
  const cell = ruleCell(going === undefined || going === null ? rule : { ...rule, on: going, level });
  const c = control(cell, level);
  const set = (on: boolean | null, at: Level) => void run("it", on, () => api.ruleSet(scope, at, rule.id, on, rule.fields));
  const line = ruleFieldsLine(rule.fields);
  return (
    <div className="atv-row-wrap">
      <div className="atv-row">
        <div className="min-w-0 flex-1">
          <div className="atv-agent">{rule.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <StateTag state={cell.state} />
            <span className="atv-level">{levelWord(cell.level)}</span>
          </div>
        </div>
        {c.kind === "switch" && <Sw on={c.on} busy={going !== undefined} label={rule.name} onFlip={() => set(!c.on, level)} />}
      </div>
      <div className="atv-rule-more">
        <div className="atv-sub">{rule.about}</div>
        <div className="atv-sub">For {rule.agents.map(providerName).join(", ")}.</div>
        {line && <div className="atv-sub break-words text-[var(--tg-text)]">{line}</div>}
        {c.kind === "decided" && <div className="atv-sub">{levelWord(c.by)} decides here, so {levelWord(level)} wouldn't change this.</div>}
        {(ruleHasFields(rule) || c.kind === "decided" || (c.kind === "switch" && c.clear)) && (
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            {ruleHasFields(rule) && c.kind !== "decided" && <Btn onClick={() => setEdit(true)} ariaLabel={`Edit ${rule.name}`}>EDIT</Btn>}
            {c.kind === "switch" && c.clear && <Btn disabled={going !== undefined} onClick={() => set(null, level)} ariaLabel={`Clear ${levelWord(level)}'s pick for ${rule.name}`}>CLEAR</Btn>}
            {c.kind === "decided" && <Btn disabled={going !== undefined} onClick={() => set(null, c.by)} ariaLabel={`Clear ${levelWord(c.by)}'s pick for ${rule.name}`}>CLEAR IT</Btn>}
          </div>
        )}
      </div>
      <RowError text={errors.it} />
      {edit && <FieldsSheet rule={rule} level={level} scope={scope} onDone={refresh} onClose={() => setEdit(false)} />}
    </div>
  );
}

function Activity({ session, names }: { session: string | null; names: Map<string, string> }) {
  const [whole, setWhole] = useState(!session);
  const q = useQuery({
    queryKey: ["at-rules-log", whole ? "" : session],
    queryFn: () => api.rulesLog(whole ? null : session),
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="sset-head flex-1">Recent activity</span>
        {session && (
          <div className="sseg atv-seg atv-seg-small" role="group" aria-label="Whose activity">
            <button type="button" aria-pressed={!whole} onClick={() => setWhole(false)}>This chat</button>
            <button type="button" aria-pressed={whole} onClick={() => setWhole(true)}>All</button>
          </div>
        )}
      </div>
      {q.isLoading ? <Loading what="activity" />
        : q.isError && !q.data ? <Fail error={q.error} onRetry={() => void q.refetch()} />
        : !q.data?.rows.length ? <Empty>no rule has fired since the bridge started.</Empty>
        : (
          <div className="sset">
            {q.data.rows.map((r, i) => (
              <div key={`${r.at}|${i}`} className="px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="atv-agent min-w-0 flex-1 break-words">{names.get(r.rule) ?? r.rule}</span>
                  <span className="flex-none text-[10px] tracking-wider text-[var(--tg-hint)]">{ago(r.at)}</span>
                </div>
                <div className="atv-sub text-[var(--brand-soft)]">{r.decision}{r.tool ? ` · ${r.tool}` : ""}</div>
                {r.why && <div className="mt-0.5 break-all text-[11px] leading-snug text-[var(--tg-hint)]"><code>{r.why}</code></div>}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

export function RulesPane({ scope, level }: { scope: ToolScope; level: Level }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["at-rules", scope.session, scope.project], queryFn: () => api.rules(scope) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["at-rules"] });
  if (q.isLoading) return <Loading what="rules" />;
  if (!q.data) return <Fail error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.rules.length) return <Empty>no rules to set.</Empty>;
  const names = new Map(q.data.rules.map((r) => [r.id, r.name]));
  return (
    <div className="space-y-4">
      {ruleGroups(q.data.rules).map((g) => (
        <div key={g.group} className="space-y-1.5">
          <div className="sset-head">{g.group}</div>
          <div className="sset">
            {g.rules.map((r) => <RuleRow key={r.id} rule={r} level={level} scope={scope} refresh={refresh} />)}
          </div>
        </div>
      ))}
      <Activity session={scope.session} names={names} />
    </div>
  );
}
