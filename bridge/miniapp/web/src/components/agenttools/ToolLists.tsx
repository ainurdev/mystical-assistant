import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api";
import {
  control, levelWord, matches, stateMeaning, summarize, withPick,
  type AgentToolsGrid, type Cell, type Cells, type Level, type McpItem, type McpTool, type SkillItem, type ToolScope,
} from "../../lib/agenttools";
import { usePersistentState } from "../../lib/persistentState";
import { Btn, Confirm, Empty, Filter, messageOf, RowError, StateTag, Sw, useAct } from "./parts";

/* MCP, Skills, Tools, Mystical tools: a list of things, each opening into one row per agent,
   because a grid of agents by things doesn't fit in 390 px. Every row writes at the level
   picked at the top, with two exceptions the screen says out loud: a skill's share is one
   switch for the machine, and a sensitive MCP tool is allowed per server, for every agent.

   The bridge keeps no record of a first share, so "first" is per browser, as on the dashboard. */

const FILTER_FROM = 8;

type Env = {
  grid: AgentToolsGrid; scope: ToolScope; cwd: string | null; level: Level; refresh: () => Promise<unknown>;
};

function Item({ name, sub, children }: { name: string; sub: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="atv-item-head">
        {open ? <ChevronDown size={14} aria-hidden className="flex-none" /> : <ChevronRight size={14} aria-hidden className="flex-none" />}
        <span className="min-w-0 flex-1">
          <span className="atv-name">{name}</span>
          <span className="atv-sub">{sub}</span>
        </span>
      </button>
      {open && <div className="atv-item-body">{children}</div>}
    </div>
  );
}

/** One agent's line. Where the state is the whole story (installed, can't) there's nothing to press. */
function AgentRow({ label, cell, level, what, busy, error, onSet }: {
  label: string; cell: Cell; level: Level; what: string; busy: boolean; error?: string;
  onSet?: (on: boolean | null, at: Level) => void;
}) {
  const c = control(cell, level);
  const words = stateMeaning(cell);
  const showsLevel = cell.state !== "installed" && cell.state !== "cant";
  return (
    <div className="atv-row-wrap">
      <div className="atv-row">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="atv-agent">{label}</span>
            <StateTag state={cell.state} />
            {showsLevel && <span className="atv-level">{levelWord(cell.level)}</span>}
          </div>
          {words && <div className="atv-sub">{words}</div>}
          {c.kind === "decided" && onSet && <div className="atv-sub">{levelWord(c.by)} decides here, so {levelWord(level)} wouldn't change this.</div>}
        </div>
        {onSet && c.kind === "switch" && c.clear && (
          <Btn disabled={busy} onClick={() => onSet(null, level)} ariaLabel={`Clear ${levelWord(level)}'s pick for ${what}, ${label}`}>CLEAR</Btn>
        )}
        {onSet && c.kind === "switch" && (
          <Sw on={c.on} busy={busy} label={`${what} for ${label}`} onFlip={() => onSet(!c.on, level)} />
        )}
        {onSet && c.kind === "decided" && (
          <Btn disabled={busy} onClick={() => onSet(null, c.by)} ariaLabel={`Clear ${levelWord(c.by)}'s pick for ${what}, ${label}`}>CLEAR IT</Btn>
        )}
      </div>
      <RowError text={error} />
    </div>
  );
}

/** Tools and Mystical tools: the same rows, written through the policy route. */
function PolicyRows({ env, section, name, cells, onShare }: {
  env: Env; section: "mcp" | "tool" | "mystical"; name: string; cells: Cells;
  onShare?: (agent: string, go: () => void) => void;
}) {
  const { pending, errors, run } = useAct(env.refresh);
  return (
    <>
      {env.grid.agents.map((a) => {
        const cell = cells[a.id];
        if (!cell) return null;
        const going = pending[a.id];
        return (
          <AgentRow key={a.id} label={a.label} level={env.level} what={name} error={errors[a.id]}
            cell={going === undefined || going === null ? cell : withPick(cell, section, going, env.level)}
            busy={going !== undefined}
            onSet={(on, at) => {
              const go = () => void run(a.id, on, () => api.toolPolicy(env.scope, at, section, name, a.id, on));
              if (on === true && cell.state === "off" && onShare) onShare(a.id, go);
              else go();
            }} />
        );
      })}
    </>
  );
}

function FilteredList<T>({ items, keyOf, text, none, render, label }: {
  items: T[]; keyOf: (t: T) => string; text: (t: T) => (string | undefined)[]; none: ReactNode; label: string;
  render: (t: T) => ReactNode;
}) {
  const [q, setQ] = useState("");
  if (!items.length) return <Empty>{none}</Empty>;
  const shown = items.filter((t) => matches(q, ...text(t)));
  return (
    <div className="space-y-2">
      {items.length >= FILTER_FROM && <Filter value={q} onChange={setQ} label={label} />}
      {shown.length
        ? <div className="sset">{shown.map((t) => <div key={keyOf(t)}>{render(t)}</div>)}</div>
        : <Empty>nothing by that name.</Empty>}
    </div>
  );
}

/** The tools a server holds. Listing them starts it if nothing has, so that waits for a tap. */
function McpToolRows({ item, cwd, refresh }: { item: McpItem; cwd: string | null; refresh: () => Promise<unknown> }) {
  const [tools, setTools] = useState<McpTool[] | null>(item.tools);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<McpTool | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => {
    setLoading(true);
    setError(null);
    api.mcpTools(item.name, cwd).then((r) => setTools(r.tools), (e: unknown) => setError(messageOf(e))).finally(() => setLoading(false));
  };
  const set = async (t: McpTool, on: boolean) => {
    await api.mcpToolSet(item.name, t.name, on, cwd);
    setTools((ts) => ts?.map((x) => (x.name === t.name ? { ...x, on } : x)) ?? ts);
    void refresh();
  };
  const off = (t: McpTool) => {
    setBusy(t.name);
    setError(null);
    set(t, false).catch((e: unknown) => setError(messageOf(e))).finally(() => setBusy(null));
  };
  if (loading) return <div className="atv-note" role="status">Starting {item.name} to list its tools…</div>;
  if (!tools) {
    return (
      <div className="px-3 py-2">
        <RowError text={error ?? undefined} />
        <Btn onClick={load}>{error ? "TRY AGAIN" : "LIST ITS TOOLS"}</Btn>
      </div>
    );
  }
  if (!tools.length) return <div className="atv-note">It lists no tools.</div>;
  const risky = tools.filter((t) => t.sensitive);
  const plain = tools.filter((t) => !t.sensitive);
  return (
    <>
      <RowError text={error ?? undefined} />
      {risky.length > 0 && (
        <div>
          <div className="atv-warn">
            <TriangleAlert size={13} aria-hidden className="mt-0.5 flex-none" />
            <span>These can reveal a secret or change infrastructure, so each stays off until you enable it by name. That holds for every agent this server is shared with, at every level.</span>
          </div>
          {risky.map((t) => (
            <div key={t.name} className="atv-row">
              <code className="min-w-0 flex-1 break-all text-[12px] text-[var(--tg-text)]">{t.name}</code>
              <Sw on={t.on} busy={busy === t.name} label={`Allow ${t.name}`} onFlip={() => (t.on ? off(t) : setAsk(t))} />
            </div>
          ))}
        </div>
      )}
      {plain.length > 0 && (
        <div className="atv-note break-words">{risky.length > 0 ? "Always on: " : "Its tools: "}{plain.map((t) => t.name).join(", ")}</div>
      )}
      {ask && (
        <Confirm title="Enable by name" danger ok={`ENABLE ${ask.name}`} onCancel={() => setAsk(null)}
          body={<><code className="break-all">{ask.name}</code> can reveal a secret or change infrastructure. Let every agent {item.name} is shared with call it?</>}
          onOk={async () => { await set(ask, true); setAsk(null); }} />
      )}
    </>
  );
}

function McpBody({ env, item }: { env: Env; item: McpItem }) {
  const [warned, setWarned] = usePersistentState<string[]>("ma-mcp-share-warned", []);
  const [ask, setAsk] = useState<{ agent: string; go: () => void } | null>(null);
  const [tools, setTools] = useState(false);
  const label = (id: string) => env.grid.agents.find((a) => a.id === id)?.label ?? id;
  return (
    <>
      <div className="atv-note">
        {item.transport} · in {label(item.home)}{item.holds_key ? " · holds a key" : ""}{item.logged_in ? " · logged in" : ""}.{" "}
        {item.known
          ? "Known to work on local or public data with no account of yours, so every agent has it unless you switch one off."
          : `Unknown, so it stays with ${label(item.home)} until you share it.`}
      </div>
      <PolicyRows env={env} section="mcp" name={item.name} cells={item.cells} onShare={(agent, go) => {
        if (warned.includes(`${item.name}|${agent}`)) go();
        else setAsk({ agent, go });
      }} />
      <button type="button" aria-expanded={tools} onClick={() => setTools((t) => !t)} className="atv-fold">
        {tools ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}TOOLS
      </button>
      {tools && <McpToolRows item={item} cwd={env.cwd} refresh={env.refresh} />}
      {ask && (
        <Confirm title="Where results go" ok="SHARE" onCancel={() => setAsk(null)}
          body={<>Share {item.name} with {label(ask.agent)} at {levelWord(env.level)}? Its key stays with Mystical, but what its tools return goes to {label(ask.agent)}'s vendor.</>}
          onOk={() => {
            setWarned((w) => [...w, `${item.name}|${ask.agent}`]);
            ask.go();
            setAsk(null);
          }} />
      )}
    </>
  );
}

function SkillBody({ env, item }: { env: Env; item: SkillItem }) {
  const { pending, errors, run } = useAct(env.refresh);
  const going = pending.share;
  const on = going === undefined || going === null ? item.on : going;
  const can = Object.values(item.cells).some((c) => c.state === "shared" || c.state === "off");
  const cellOf = (c: Cell): Cell => (c.state === "shared" || c.state === "off" ? { ...c, state: on ? "shared" : "off" } : c);
  return (
    <>
      <div className="atv-note">
        {item.scope === "project" ? "This project" : "All projects"} · from {item.home === "claude" ? "Claude" : ".agents"}.
        {item.conflict ? " A different skill already has this name on the other side, so this one can't be shared. Rename one of them." : ""}
        {item.claude_only && !item.conflict ? " Written with Claude in mind: it names tools other agents don't have, or limits its tools in a way they may ignore. It stays off until you switch it on." : ""}
      </div>
      {can && !item.conflict && (
        <div className="atv-row-wrap">
          <div className="atv-row">
            <div className="min-w-0 flex-1">
              <div className="atv-agent">Share with the other agents</div>
              <div className="atv-sub">One folder, one switch for the whole machine, whatever level is picked above.</div>
            </div>
            <Sw on={on} busy={going !== undefined} label={`Share ${item.name}`}
              onFlip={() => void run("share", !on, () => api.skillShareSet(item.key, !on, env.cwd))} />
          </div>
          <RowError text={errors.share} />
        </div>
      )}
      {env.grid.agents.map((a) => item.cells[a.id] && (
        <AgentRow key={a.id} label={a.label} level={env.level} what={item.name} busy={false} cell={cellOf(item.cells[a.id])} />
      ))}
    </>
  );
}

export function McpPane({ env }: { env: Env }) {
  return (
    <FilteredList items={env.grid.mcp} keyOf={(m) => m.name} text={(m) => [m.name, m.home]} label="Filter servers"
      none="no MCP servers are installed for any agent yet."
      render={(m) => <Item name={m.name} sub={summarize(m.cells)}><McpBody env={env} item={m} /></Item>} />
  );
}

export function SkillsPane({ env }: { env: Env }) {
  return (
    <FilteredList items={env.grid.skills} keyOf={(s) => `${s.key}|${s.home}`} text={(s) => [s.name]} label="Filter skills"
      none="no skills are installed yet."
      render={(s) => <Item name={s.name} sub={summarize(s.cells)}><SkillBody env={env} item={s} /></Item>} />
  );
}

export function ToolsPane({ env }: { env: Env }) {
  return (
    <div className="space-y-3">
      <FilteredList items={env.grid.tools} keyOf={(t) => t.name} text={(t) => [t.name, t.label]} label="Filter tools"
        none="no built-in tools to switch."
        render={(t) => (
          <Item name={t.label} sub={`${t.name} · ${summarize(t.cells)}`}>
            <PolicyRows env={env} section="tool" name={t.name} cells={t.cells} />
          </Item>
        )} />
      {env.grid.patterns.length > 0 && (
        <div className="space-y-1">
          <div className="sset-head">Denied by pattern</div>
          <div className="sset px-3 py-2">
            {env.grid.patterns.map((p) => <div key={p} className="break-all py-0.5 text-[12px] text-[var(--tg-text)]"><code>{p}</code></div>)}
          </div>
          <div className="atv-sub">In force for Claude here, on top of the switches above. Read only on this screen.</div>
        </div>
      )}
    </div>
  );
}

export function MysticalPane({ env }: { env: Env }) {
  return (
    <FilteredList items={env.grid.mystical} keyOf={(t) => t.name} text={(t) => [t.name, t.about]} label="Filter Mystical tools"
      none="no Mystical tools."
      render={(t) => (
        <Item name={t.name} sub={summarize(t.cells)}>
          {t.about && <div className="atv-note">{t.about}.</div>}
          <PolicyRows env={env} section="mystical" name={t.name} cells={t.cells} />
        </Item>
      )} />
  );
}

export type { Env as ToolsEnv };
