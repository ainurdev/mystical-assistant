import { useCallback, useState } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import {
  STATE_WORD, canReset, cellWhy, heldByChatSwitch, levelTag, mcpNeedsLogin, type AgentRef, type Cell, type McpGridRow,
  type McpToolRow, type MysticalGridRow, type Scope, type Section, type SkillGridRow, type ToolGridRow,
} from "../../lib/agenttools";
import { multi } from "../../lib/multistore";
import { askConfirm } from "../ui/Ask";
import { MiniBtn, Switch } from "./SettingsModal";

/* What opens under a grid row: where the thing is defined, each agent's state in a sentence,
   and for an MCP server its tools and its login. Each sensitive tool stays off until it's
   enabled by name, with a warning: a tool's name is all there is to go on. */

const MCP_HOMES: Record<string, string> = {
  claude: "Claude's MCP config: claude mcp, or a project's .mcp.json",
  kimi: "Kimi Code's ~/.kimi-code/mcp.json",
  gemini: "Gemini's ~/.gemini/settings.json",
  codex: "Codex's ~/.codex/config.toml",
  opencode: "OpenCode's ~/.config/opencode/opencode.json",
};

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="at-kv"><span>{k}</span><div>{children}</div></div>;
}

function McpTools({ row, cwd }: { row: McpGridRow; cwd?: string | null }) {
  const [tools, setTools] = useState<McpToolRow[] | null>(row.tools);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    multi.mcpTools(row.name, cwd)
      .then((r) => setTools(r.tools), (e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [row.name, cwd]);
  const flip = async (t: McpToolRow) => {
    const on = !t.on;
    if (on && !await askConfirm(`Enable ${t.name}? It can reveal a secret or change infrastructure, and every agent ${row.name} is shared with could call it.`, { ok: "Enable", danger: true })) return;
    setTools((ts) => ts?.map((x) => (x.name === t.name ? { ...x, on } : x)) ?? ts);
    setError(null);
    multi.mcpSet({ name: row.name, tool: t.name, on, cwd }).catch((e: Error) => {
      setError(e.message);
      setTools((ts) => ts?.map((x) => (x.name === t.name ? { ...x, on: !on } : x)) ?? ts);
    });
  };
  if (loading) return <div className="ma-set-note" role="status">Starting {row.name} to list its tools…</div>;
  if (!tools) {
    return (
      <div className="at-kvnote">
        {error && <div className="ma-set-err" role="alert">Couldn&apos;t list its tools: {error}</div>}
        <button type="button" className="ma-link" onClick={load}>{error ? "try again" : `start ${row.name} and list its tools`}</button>
      </div>
    );
  }
  if (!tools.length) return <div className="ma-set-note">It lists no tools.</div>;
  const risky = tools.filter((t) => t.sensitive);
  const plain = tools.filter((t) => !t.sensitive);
  return (
    <div className="ma-set-tools at-tools">
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
      <button type="button" className="ma-link at-relist" onClick={load}>list them again</button>
    </div>
  );
}

function AgentLines({ section, name, cells, agents, scope, disabled, onReset }: {
  section: Section; name: string; cells: Record<string, Cell>; agents: AgentRef[]; scope: Scope; disabled?: string[] | null;
  onReset: (agent: AgentRef) => void;
}) {
  return (
    <div className="at-lines">
      {agents.map((a) => {
        const c = cells[a.id];
        if (!c) return null;
        const held = heldByChatSwitch(section, name, c, scope, disabled);
        return (
          <div key={a.id} className="at-line">
            <b>{a.label}</b>
            <span className="at-line-st" data-state={c.state}>{STATE_WORD[c.state]}{levelTag(c) && <em>{levelTag(c)}</em>}</span>
            <span className="at-line-why">{held ? "Off in this chat's ⚒ Tools, which is its own switch: change it there, in the chat." : cellWhy(section, c, a.label)}</span>
            {!held && canReset(section, c, scope.level) && (
              <button type="button" className="ma-link" onClick={() => onReset(a)}><RotateCcw size={10} aria-hidden />reset</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function McpDetail({ row, agents, scope, cwd, onReset, onLogin, onLogout }: {
  row: McpGridRow; agents: AgentRef[]; scope: Scope; cwd?: string | null;
  onReset: (a: AgentRef) => void; onLogin: () => void; onLogout: () => void;
}) {
  const needs = mcpNeedsLogin(row);
  return (
    <>
      <Kv k="Defined in"><code>{MCP_HOMES[row.home] ?? row.home}</code></Kv>
      <Kv k="Kind">
        {row.transport === "http" ? "A remote server" : "A local command"}
        {row.holds_key ? ". It holds a key, and the key stays with Mystical." : "."}
        {row.known ? " Known to work on local or public data with no account of yours, so every agent has it unless you switch one off."
          : " Unknown to Mystical, so it stays with its home until you share it."}
      </Kv>
      {row.transport === "http" && !row.holds_key && !row.known && (
        <Kv k="Login">
          <span className="at-kvline">
            {row.logged_in ? "Logged in for shared use." : needs ? "It needs its own login before it can be shared." : "No login needed."}
            {needs && <MiniBtn primary onClick={onLogin}>LOG IN</MiniBtn>}
            {row.logged_in && <MiniBtn onClick={onLogout}>LOG OUT</MiniBtn>}
          </span>
        </Kv>
      )}
      <Kv k="Agents"><AgentLines section="mcp" name={row.name} cells={row.cells} agents={agents} scope={scope} onReset={onReset} /></Kv>
      <Kv k="Tools"><McpTools key={`${row.name}:${row.tools?.length ?? 0}`} row={row} cwd={cwd} /></Kv>
    </>
  );
}

export function SkillDetail({ row, agents, scope }: { row: SkillGridRow; agents: AgentRef[]; scope: Scope }) {
  const where = row.home === "claude" ? ".claude/skills" : ".agents/skills";
  return (
    <>
      <Kv k="Defined in"><code>{row.scope === "project" ? `${where}/${row.name}` : `~/${where}/${row.name}`}</code>{row.scope === "project" ? " in this project" : " for every project"}</Kv>
      <Kv k="Sharing">One switch per skill: a link to one folder, seen from the other agents&apos; path. Nothing is copied, and it holds at every level.</Kv>
      {row.conflict && <Kv k="Name taken">A different skill already has this name on the other side, so this one can&apos;t be shared. Rename one of them.</Kv>}
      {row.claude_only && !row.conflict && <Kv k="Written for Claude">It names tools other agents don&apos;t have, or limits its tools in a way they may ignore. It stays off until you switch it on.</Kv>}
      <Kv k="Agents"><AgentLines section="skills" name={row.name} cells={row.cells} agents={agents} scope={scope} onReset={() => {}} /></Kv>
    </>
  );
}

export function ToolDetail({ row, agents, scope, disabled, onReset }: {
  row: ToolGridRow; agents: AgentRef[]; scope: Scope; disabled?: string[] | null; onReset: (a: AgentRef) => void;
}) {
  return (
    <>
      <Kv k="What">{row.label}. A built-in of Claude Code: <code>{row.name}</code>. Off, it leaves the model&apos;s context for the next turn, through <code>--disallowedTools</code>.</Kv>
      <Kv k="Agents"><AgentLines section="tool" name={row.name} cells={row.cells} agents={agents} scope={scope} disabled={disabled} onReset={onReset} /></Kv>
    </>
  );
}

export function MysticalDetail({ row, agents, scope, onReset }: { row: MysticalGridRow; agents: AgentRef[]; scope: Scope; onReset: (a: AgentRef) => void }) {
  return (
    <>
      <Kv k="What">{row.about}.</Kv>
      <Kv k="Defined in">Mystical&apos;s own gateway, the same for every agent: <code>{row.name}</code>.</Kv>
      <Kv k="Agents"><AgentLines section="mystical" name={row.name} cells={row.cells} agents={agents} scope={scope} onReset={onReset} /></Kv>
    </>
  );
}
