import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FlaskConical, Puzzle, Share2, TriangleAlert } from "lucide-react";
import { agentLabel } from "../../lib/agents";
import { multi, setExperimental, useExperimental, type McpShareRow, type McpTool, type SkillShareRow } from "../../lib/multistore";
import { useStickySet } from "../../lib/prefs";
import { HelpersRow } from "../HelpersRow";
import { askConfirm } from "../ui/Ask";
import { CARD, MiniBtn, Row, Section, Switch } from "./SettingsModal";

/* SETTINGS ▸ System ▸ Experimental: the switch behind multi-agent chats, the limits
   a new chat starts from, and, while it's on, what's shared between models.
   docs/superpowers/plans/multi-agent-chats.md holds the rules; bridge/mcp_share.py
   and bridge/skill_share.py hold the choices. The bridge keeps no record of a
   first share, so the warning's "first time" is per browser. */

const homeName = (h: string) => (h === "claude" ? "Claude" : agentLabel(h));
const SKILL_FOLD = 8;

function McpTools({ row, cwd }: { row: McpShareRow; cwd?: string | null }) {
  const [tools, setTools] = useState<McpTool[] | null>(row.tools);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!row.tools);
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    multi.mcpTools(row.name, cwd)
      .then((r) => setTools(r.tools), (e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [row.name, cwd]);
  useEffect(() => { if (!row.tools) load(); }, [row.tools, load]);
  const flip = async (t: McpTool) => {
    const on = !t.on;
    if (on && !await askConfirm(`${t.name} can reveal a secret or change infrastructure. Let every model this server is shared with call it?`, { ok: "Enable", danger: true })) return;
    setTools((ts) => ts?.map((x) => (x.name === t.name ? { ...x, on } : x)) ?? ts);
    multi.mcpSet({ name: row.name, tool: t.name, on, cwd }).catch((e: Error) => {
      setError(e.message);
      setTools((ts) => ts?.map((x) => (x.name === t.name ? { ...x, on: !on } : x)) ?? ts);
    });
  };
  if (loading) return <div className="ma-set-note" role="status">Starting {row.name} to list its tools…</div>;
  if (error && !tools) return <div className="ma-set-err" role="alert">Couldn't list its tools: {error} <button type="button" className="ma-link" onClick={load}>try again</button></div>;
  if (!tools?.length) return <div className="ma-set-note">It lists no tools.</div>;
  const risky = tools.filter((t) => t.sensitive);
  const plain = tools.filter((t) => !t.sensitive);
  return (
    <div className="ma-set-tools">
      {error && <div className="ma-set-err" role="alert">{error}</div>}
      {risky.length > 0 && (
        <>
          <div className="ma-set-warn"><TriangleAlert size={12} aria-hidden />These can reveal a secret or change infrastructure, so they stay off until you enable each by name.</div>
          {risky.map((t) => (
            <div key={t.name} className="ma-set-tool">
              <code>{t.name}</code>
              <span style={{ flex: 1 }} />
              <Switch on={t.on} onClick={() => void flip(t)} label={`Allow ${t.name}`} />
            </div>
          ))}
        </>
      )}
      {plain.length > 0 && <div className="ma-set-note">{risky.length > 0 ? "Always on: " : ""}{plain.map((t) => t.name).join(", ")}</div>}
    </div>
  );
}

function McpRow({ row, cwd, first, warned, onWarned, reload }: {
  row: McpShareRow; cwd?: string | null; first: boolean; warned: Set<string>; onWarned: (k: string) => void; reload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState(row.agents);
  useEffect(() => { setPicks(row.agents); }, [row.agents]);
  const flip = async (agent: string) => {
    const on = !picks[agent];
    const key = `${row.name}|${agent}`;
    if (on && !warned.has(key)) {
      const yes = await askConfirm(`Share ${row.name} with ${agentLabel(agent)}? Its key stays with Mystical, but what its tools return goes to ${agentLabel(agent)}'s vendor.`, { ok: "Share" });
      if (!yes) return;
      onWarned(key);
    }
    setPicks((p) => ({ ...p, [agent]: on }));
    setError(null);
    multi.mcpSet({ name: row.name, agent, on, cwd }).catch((e: Error) => {
      setError(e.message);
      setPicks((p) => ({ ...p, [agent]: !on }));
    });
  };
  const act = (p: Promise<unknown>) => { setError(null); p.then(reload, (e: Error) => setError(e.message)); };
  const login = () => {
    setError(null);
    multi.mcpLogin(row.name, cwd).then((r) => { window.open(r.url, "_blank", "noopener"); }, (e: Error) => setError(e.message));
  };
  const agents = Object.keys(picks);
  return (
    <div className="ma-set-row" data-first={first || undefined}>
      <div className="ma-set-line">
        <span className="ma-set-name">{row.name}</span>
        <span className="ma-set-meta">{row.transport} · in {homeName(row.home)}{row.holds_key ? " · holds a key" : ""}</span>
        <span style={{ flex: 1 }} />
        {row.needs_login && <MiniBtn primary onClick={login}>LOG IN</MiniBtn>}
        {row.logged_in && <MiniBtn onClick={() => act(multi.mcpLogout(row.name, cwd))}>LOG OUT</MiniBtn>}
        <button type="button" className="ma-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}tools
        </button>
      </div>
      <div className="ma-set-word">
        {row.known
          ? "Known to work on local or public data with no account of yours, so every model has it unless you switch one off."
          : `Unknown, so it stays with ${homeName(row.home)} until you share it with a model.`}
        {row.needs_login ? " It needs its own login to be shared." : ""}
      </div>
      {agents.length > 0
        ? (
          <div className="ma-set-agents">
            {agents.map((a) => (
              <span key={a} className="ma-set-agent">
                <span>{agentLabel(a)}</span>
                <Switch on={!!picks[a]} onClick={() => void flip(a)} label={`Share ${row.name} with ${agentLabel(a)}`} />
              </span>
            ))}
          </div>
        )
        : <div className="ma-set-note">No other model is signed in here to share it with.</div>}
      {error && <div className="ma-set-err" role="alert">{error}</div>}
      {open && <McpTools row={row} cwd={cwd} />}
    </div>
  );
}

function McpCard({ cwd }: { cwd?: string | null }) {
  const [rows, setRows] = useState<McpShareRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useStickySet("hud-mcp-share-warned");
  const load = useCallback(() => {
    multi.mcpShare(cwd).then((r) => { setRows(r.servers); setError(null); }, (e: Error) => setError(e.message));
  }, [cwd]);
  useEffect(() => { load(); }, [load]);
  return (
    <Section title="SHARED MCP SERVERS" icon={Share2} top desc="Which model may use which server, through Mystical. Mystical holds the keys.">
      <div style={CARD}>
        {error && <div className="ma-set-err" role="alert">Couldn't read the servers: {error} <button type="button" className="ma-link" onClick={load}>try again</button></div>}
        {!rows && !error && <div className="ma-set-note" role="status">Reading servers…</div>}
        {rows?.length === 0 && <div className="ma-set-note">No MCP servers are installed for any model yet.</div>}
        {rows?.map((r, i) => (
          <McpRow key={r.name} row={r} cwd={cwd} first={i === 0} warned={warned} reload={load}
            onWarned={(k) => setWarned((s) => new Set(s).add(k))} />
        ))}
      </div>
    </Section>
  );
}

function SkillsCard({ cwd }: { cwd?: string | null }) {
  const [rows, setRows] = useState<SkillShareRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(() => {
    multi.skillShare(cwd).then((r) => { setRows(r.skills); setError(null); }, (e: Error) => setError(e.message));
  }, [cwd]);
  useEffect(() => { load(); }, [load]);
  const flip = (r: SkillShareRow) => {
    const on = !r.on;
    setRows((rs) => rs?.map((x) => (x.key === r.key ? { ...x, on } : x)) ?? rs);
    setError(null);
    multi.skillSet(r.key, on, cwd).then((d) => setRows(d.skills), (e: Error) => {
      setError(e.message);
      setRows((rs) => rs?.map((x) => (x.key === r.key ? { ...x, on: !on } : x)) ?? rs);
    });
  };
  const shown = rows && !all ? rows.slice(0, SKILL_FOLD) : rows;
  return (
    <Section title="SHARED SKILLS" icon={Puzzle} top desc="A shared skill is one folder every agent can read. Nothing is copied.">
      <div style={CARD}>
        {error && <div className="ma-set-err" role="alert">Couldn't change the skills: {error} <button type="button" className="ma-link" onClick={load}>try again</button></div>}
        {!rows && !error && <div className="ma-set-note" role="status">Reading skills…</div>}
        {rows?.length === 0 && <div className="ma-set-note">No skills are installed yet.</div>}
        {shown?.map((r, i) => (
          <div key={r.key} className="ma-set-row" data-first={i === 0 || undefined}>
            <div className="ma-set-line">
              <span className="ma-set-name">{r.name}</span>
              <span className="ma-set-meta">{r.scope === "project" ? "this project" : "all projects"} · from {r.home === "claude" ? "Claude" : ".agents"}</span>
              <span style={{ flex: 1 }} />
              {r.conflict
                ? <span className="ma-tag" data-tone="warn" title="It can't be linked while the name is taken">NAME TAKEN</span>
                : <Switch on={r.on} onClick={() => flip(r)} label={`Share ${r.name}`} />}
            </div>
            {r.conflict && <div className="ma-set-word">A different skill already has this name on the other side, so this one can't be shared. Rename one of them.</div>}
            {r.claude_only && !r.conflict && <div className="ma-set-word">Written with Claude in mind: it names tools other agents don't have, or limits its tools in a way they may ignore. It stays off until you switch it on.</div>}
          </div>
        ))}
        {rows && rows.length > SKILL_FOLD && (
          <button type="button" className="ma-link ma-set-all" onClick={() => setAll((a) => !a)}>{all ? "show fewer" : `show all ${rows.length}`}</button>
        )}
      </div>
    </Section>
  );
}

/** SETTINGS ▸ System's EXPERIMENTAL block. `top` as Section's: it follows another. */
export function ExperimentalSection({ cwd, top }: { cwd?: string | null; top?: boolean }) {
  const exp = useExperimental();
  const [error, setError] = useState<string | null>(null);
  const flip = () => {
    setError(null);
    setExperimental({ enabled: !exp.enabled }).catch((e: Error) => setError(e.message));
  };
  return (
    <>
      <Section title="EXPERIMENTAL" icon={FlaskConical} top={top}
        desc="Lets a chat switch provider between turns and run helper agents beside it, with MCP servers and skills shared across models."
        info={<>
          Off, the bridge and the dashboard behave as they did. Helpers cost tokens quickly: this suits review, research and
          well-separated pieces, and suits tightly linked coding less. What's sent to another provider goes to its vendor.
          One gap stays open: an agent with shell access could start Claude itself, outside these rules. Asking mode and deny rules are the mitigation.
        </>}>
        <div style={CARD}>
          <Row first label="MULTI-AGENT CHATS"
            desc={exp.stale ? "The bridge is running older code than this dashboard. Restart the bridge to use this." : undefined}>
            {exp.stale ? <span className="ma-tag" data-tone="warn">RESTART THE BRIDGE</span>
              : !exp.loaded ? <span className="ma-set-note" role="status">reading…</span>
              : <Switch on={exp.enabled} onClick={flip} label="Multi-agent chats" />}
          </Row>
          {error && <div className="ma-set-err" role="alert">{error}</div>}
          {exp.enabled && (
            <Row label="A NEW CHAT STARTS WITH" desc="Each chat can change these in its model picker. Lowering a limit stops nothing already running." />
          )}
          {exp.enabled && (
            <HelpersRow config={exp.defaults} onChange={(patch) => setExperimental({ defaults: patch }).catch((e: Error) => { setError(e.message); throw e; })} />
          )}
        </div>
      </Section>
      {exp.enabled && <McpCard cwd={cwd} />}
      {exp.enabled && <SkillsCard cwd={cwd} />}
    </>
  );
}
