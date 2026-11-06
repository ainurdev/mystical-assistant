import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Search, TriangleAlert, X } from "lucide-react";
import {
  AT_TABS, LEVEL_LABEL, columnNotes, cwdOf, heldByChatSwitch, matches, nextOn, parseFocus, patchCell, pickedState, secTab, shareKey,
  type AgentRef, type AtTab, type Cell, type Level, type McpGridRow, type MysticalGridRow, type Scope, type Section,
  type SkillGridRow, type ToolGrid, type ToolGridRow,
} from "../../lib/agenttools";
import { at, isStaleBridge, type PolicySection } from "../../lib/agenttoolsapi";
import { multi } from "../../lib/multistore";
import { takeSettingsFocus } from "../../lib/opensettings";
import { useStickySet } from "../../lib/prefs";
import { askConfirm } from "../ui/Ask";
import { StaleBridge } from "./AgentToolsBits";
import { HooksTab } from "./HooksTab";
import { PatternRules } from "./PatternRules";
import { RulesTab } from "./RulesTab";
import { McpPanel } from "./SettingsModal";
import { SkillsPage } from "./SkillsFold";
import { GridLoading, ToolGridTable, type GridRow } from "./ToolGridTable";
import { McpDetail, MysticalDetail, SkillDetail, ToolDetail } from "./ToolRowDetail";

/* SETTINGS ▸ Agent Tools: one page for what each agent can reach, and who said so. Behind
   the experimental switch it takes the place of CLAUDE SKILLS and AI MANAGEMENT's Claude MCP
   fold; both of those still do things only they do (install from the catalog, add a Claude
   server), so each sits in a fold under its grid and stays one click away.

   bridge/agent_tools.py answers for a level: Machine asks with nothing narrower, This
   project names the project, This chat names the session. Each level's answer already
   includes the wider ones, so the picked level is always the nearest one in view, and a
   click there always takes effect. A cell is drawn from the answer; a pick lands at once and
   the next read confirms it. A skill has no levels, and its tab says so. */

export interface ChatInfo { title?: string | null; project?: string | null; cwd?: string | null; disabled_tools?: string[] }

export interface AgentToolsProps {
  projects: { rel: string; name: string; cwd?: string | null }[];
  currentProject: string | null;
  /** The open session, if any: This chat's default. */
  sessionId: string | null;
  /** Any chat by id, for the one the ⚒ modal passes in and the activity log's links. */
  chatInfo: (id: string) => ChatInfo | undefined;
  /** Projects ▸ Skills ▸ Open: the project to start on. */
  startProject?: string | null;
  openSec?: string | null;
  onOpenChat: (id: string) => void;
}

function Fold({ title, hint, open, onToggle, children, sec }: { title: string; hint: string; open: boolean; onToggle: () => void; children: ReactNode; sec?: string }) {
  return (
    <section className="at-fold" data-open={open || undefined} data-sec={sec}>
      <button type="button" className="at-foldbtn" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={13} aria-hidden className="at-chev" /><b>{title}</b><span>{hint}</span>
      </button>
      {open && <div className="at-foldbody">{children}</div>}
    </section>
  );
}

function SearchBox({ value, onChange, placeholder, count }: { value: string; onChange: (v: string) => void; placeholder: string; count: string }) {
  return (
    <div className="at-search">
      <Search size={12} aria-hidden />
      <input value={value} placeholder={placeholder} aria-label={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.stopPropagation(); onChange(""); } }} />
      {value && <button type="button" aria-label="Clear the search" onClick={() => onChange("")}><X size={11} aria-hidden /></button>}
      <span>{count}</span>
    </div>
  );
}

export function AgentToolsPage({ projects, currentProject, sessionId, chatInfo, startProject, openSec, onOpenChat }: AgentToolsProps) {
  const [focus] = useState(() => parseFocus(takeSettingsFocus()));
  const [tab, setTab] = useState<AtTab>(focus.tab ?? secTab(openSec) ?? "mcp");
  const [level, setLevel] = useState<Level>(focus.level ?? (startProject ? "project" : "machine"));
  const chatId = focus.session ?? sessionId;
  const chat = chatId ? chatInfo(chatId) : undefined;
  const [picked, setPicked] = useState<string | null>(focus.project ?? startProject ?? currentProject ?? projects[0]?.rel ?? null);
  const project = level === "chat" ? chat?.project ?? picked : picked;
  const scope = useMemo<Scope>(() => ({ level, project, session: chatId }), [level, project, chatId]);

  const [grid, setGrid] = useState<ToolGrid | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [warned, setWarned] = useStickySet("hud-mcp-share-warned");
  const [mcpFold, setMcpFold] = useState(openSec === "MCP SERVERS" || openSec === "ADD A SERVER");
  const [skillFold, setSkillFold] = useState(!!startProject || openSec === "SKILLS");
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoadError(null);
    return at.grid(scope).then(
      (g) => { if (mine === seq.current) setGrid(g); },
      (e: Error) => { if (mine === seq.current) setLoadError(e.message); },
    );
  }, [scope]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setOpen(null); setQ(""); setProblem(null); }, [tab]);

  const agents: AgentRef[] = grid?.agents ?? [];
  const cwd = cwdOf(scope, chat?.cwd, (rel) => projects.find((p) => p.rel === rel)?.cwd);
  const mark = (key: string, on: boolean) => setBusy((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });
  const held = useCallback((section: Section) => (r: GridRow, c: Cell) => heldByChatSwitch(section, r.id, c, scope, chat?.disabled_tools), [scope, chat]);

  /** A pick at this level: drawn at once, sent, then read back, and undone if it's refused. */
  const pick = async (section: PolicySection, gridKey: "mcp" | "tools" | "mystical", name: string, agent: AgentRef, on: boolean | null) => {
    const key = `${name}|${agent.id}`;
    setProblem(null);
    mark(key, true);
    const before = grid;
    if (on !== null) {
      setGrid((g) => (g ? { ...g, [gridKey]: patchCell(g[gridKey] as { name: string; cells: Record<string, Cell> }[], (r) => r.name === name, agent.id, { state: pickedState(section, on), level }) } : g));
    }
    try {
      await at.pick(scope, section, name, agent.id, on);
      await load();
    } catch (e) {
      setGrid(before);
      setProblem((e as Error).message);
    } finally { mark(key, false); }
  };

  const onMcpCell = async (r: McpGridRow, a: AgentRef, c: Cell) => {
    const on = nextOn(c);
    const k = shareKey(r.name, a.id);
    if (on && !warned.has(k)) {
      const yes = await askConfirm(`Share ${r.name} with ${a.label}? Its key stays with Mystical, but what its tools return goes to ${a.label}'s vendor.`, { ok: "Share" });
      if (!yes) return;
      setWarned((s) => new Set(s).add(k));
    }
    await pick("mcp", "mcp", r.name, a, on);
  };
  const login = (name: string) => {
    setProblem(null);
    multi.mcpLogin(name, cwd).then((r) => { window.open(r.url, "_blank", "noopener"); }, (e: Error) => setProblem(e.message));
  };
  const logout = (name: string) => {
    setProblem(null);
    multi.mcpLogout(name, cwd).then(() => load(), (e: Error) => setProblem(e.message));
  };
  const onSkillCell = async (r: SkillGridRow, a: AgentRef, c: Cell) => {
    const on = nextOn(c);
    if (on && r.claude_only && !await askConfirm(`Share ${r.name} anyway? It was written with Claude in mind: it names tools other agents don't have, or limits its tools in a way they may ignore.`, { ok: "Share" })) return;
    const key = `${r.key}|${a.id}`;
    setProblem(null);
    mark(key, true);
    try {
      await multi.skillSet(r.key, on, cwd);
      await load();
    } catch (e) {
      setProblem((e as Error).message);
    } finally { mark(key, false); }
  };

  const reset = async (section: PolicySection, gridKey: "mcp" | "tools" | "mystical", name: string, agent: AgentRef) => pick(section, gridKey, name, agent, null);

  const noMatch = (n: number, what: string) => (
    n === 0 && q.trim()
      ? <div className="at-emptybox"><Search size={18} strokeWidth={1.4} aria-hidden /><span>Nothing in {what} matches “{q.trim()}”. <button type="button" className="ma-link" onClick={() => setQ("")}>clear the search</button></span></div>
      : null
  );
  const notes = (rows: { cells: Record<string, Cell> }[]) => columnNotes(rows, agents).map((n) => (
    <div key={n.agent} className="at-colnote"><b>{n.agent}</b>{n.why}</div>
  ));
  const searchBar = (shown: number, all: number, what: string) => (
    <SearchBox value={q} onChange={setQ} placeholder={`Search ${what}`} count={shown === all ? `${all}` : `${shown} of ${all}`} />
  );

  // ---- the four grids ----------------------------------------------------------
  const mcpTab = () => {
    const all = grid!.mcp;
    const rows = all.filter((r) => matches(q, r.name, r.home, r.transport));
    const byName = new Map(all.map((r) => [r.name, r]));
    return (
      <div data-sec="MCP">
        {all.length > 0 && searchBar(rows.length, all.length, "servers")}
        {all.length === 0 && <div className="at-emptybox"><TriangleAlert size={18} strokeWidth={1.4} aria-hidden /><span>No MCP servers are installed for any agent yet. Add one for Claude below; an agent&apos;s own config shows up here too.</span></div>}
        {noMatch(rows.length, "the servers")}
        {notes(all)}
        {rows.length > 0 && (
          <ToolGridTable section="mcp" nameHead="Server" agents={agents} level={level} busy={busy} open={open} onOpen={setOpen}
            rows={rows.map((r) => ({ id: r.name, title: r.name, sub: `${r.transport} · in ${agents.find((a) => a.id === r.home)?.label ?? r.home}`, cells: r.cells }))}
            onCell={(row, a, c) => { const r = byName.get(row.id)!; if (c.state === "login") login(r.name); else void onMcpCell(r, a, c); }}
            onReset={(row, a) => void reset("mcp", "mcp", row.id, a)}
            detail={(row) => {
              const r = byName.get(row.id)!;
              return <McpDetail row={r} agents={agents} scope={scope} cwd={cwd} onReset={(a) => void reset("mcp", "mcp", r.name, a)} onLogin={() => login(r.name)} onLogout={() => logout(r.name)} />;
            }} />
        )}
        <Fold sec="MCP SERVERS" title="Claude's own servers" hint="add one, log in again, remove: claude mcp" open={mcpFold} onToggle={() => setMcpFold((o) => !o)}>
          <McpPanel />
        </Fold>
      </div>
    );
  };

  const skillsTab = () => {
    const all = grid!.skills;
    const rows = all.filter((r) => matches(q, r.name, r.scope, r.home));
    const byKey = new Map(all.map((r) => [r.key, r]));
    return (
      <div data-sec="SKILLS">
        <div className="at-scopenote">A skill is one folder link, so a share holds for the whole machine at every level. The level above only picks whose project skills are listed.</div>
        {all.length > 0 && searchBar(rows.length, all.length, "skills")}
        {all.length === 0 && <div className="at-emptybox"><TriangleAlert size={18} strokeWidth={1.4} aria-hidden /><span>No skills are installed yet. The catalog is below.</span></div>}
        {noMatch(rows.length, "the skills")}
        {rows.length > 0 && (
          <ToolGridTable section="skills" nameHead="Skill" agents={agents} level={level} busy={busy} open={open} onOpen={setOpen}
            rows={rows.map((r) => ({ id: r.key, title: r.name, sub: `${r.scope === "project" ? "this project" : "all projects"} · from ${r.home === "claude" ? "Claude" : ".agents"}`, cells: r.cells }))}
            onCell={(row, a, c) => void onSkillCell(byKey.get(row.id)!, a, c)}
            onReset={() => {}}
            detail={(row) => <SkillDetail row={byKey.get(row.id)!} agents={agents} scope={scope} />} />
        )}
        <Fold sec="SKILL CATALOG" title="Claude's own skills" hint="installed, the catalog, plugins" open={skillFold} onToggle={() => setSkillFold((o) => !o)}>
          <SkillsPage projects={projects} project={picked} onPick={setPicked} />
        </Fold>
      </div>
    );
  };

  const toolsTab = () => {
    const all = grid!.tools;
    const rows = all.filter((r) => matches(q, r.name, r.label));
    const byName = new Map<string, ToolGridRow>(all.map((r) => [r.name, r]));
    return (
      <div data-sec="BUILT-IN TOOLS">
        {searchBar(rows.length, all.length, "tools")}
        {all.length === 0 && <div className="at-emptybox"><TriangleAlert size={18} strokeWidth={1.4} aria-hidden /><span>This bridge lists no built-in tools.</span></div>}
        {noMatch(rows.length, "the tools")}
        {notes(all)}
        {rows.length > 0 && (
          <ToolGridTable section="tool" nameHead="Tool" agents={agents} level={level} busy={busy} open={open} onOpen={setOpen} held={held("tool")}
            rows={rows.map((r) => ({ id: r.name, title: r.label, sub: r.name, cells: r.cells }))}
            onCell={(row, a, c) => void pick("tool", "tools", row.id, a, nextOn(c))}
            onReset={(row, a) => void reset("tool", "tools", row.id, a)}
            detail={(row) => <ToolDetail row={byName.get(row.id)!} agents={agents} scope={scope} disabled={chat?.disabled_tools} onReset={(a) => void reset("tool", "tools", row.id, a)} />} />
        )}
        <PatternRules key={`${level}:${project ?? ""}:${chatId ?? ""}`} scope={scope} inForce={grid!.patterns} onChanged={() => void load()} />
      </div>
    );
  };

  const mysticalTab = () => {
    const all = grid!.mystical;
    const rows = all.filter((r) => matches(q, r.name, r.about));
    const byName = new Map<string, MysticalGridRow>(all.map((r) => [r.name, r]));
    return (
      <div data-sec="MYSTICAL TOOLS">
        {all.length > 0 && searchBar(rows.length, all.length, "Mystical tools")}
        {all.length === 0 && <div className="at-emptybox"><TriangleAlert size={18} strokeWidth={1.4} aria-hidden /><span>This bridge lists no Mystical tools.</span></div>}
        {noMatch(rows.length, "Mystical's tools")}
        {notes(all)}
        {rows.length > 0 && (
          <ToolGridTable section="mystical" nameHead="Tool" agents={agents} level={level} busy={busy} open={open} onOpen={setOpen}
            rows={rows.map((r) => ({ id: r.name, title: r.name, sub: r.about, hint: `${r.name}: ${r.about}`, cells: r.cells }))}
            onCell={(row, a, c) => void pick("mystical", "mystical", row.id, a, nextOn(c))}
            onReset={(row, a) => void reset("mystical", "mystical", row.id, a)}
            detail={(row) => <MysticalDetail row={byName.get(row.id)!} agents={agents} scope={scope} onReset={(a) => void reset("mystical", "mystical", row.id, a)} />} />
        )}
      </div>
    );
  };

  const gridBody = () => {
    if (isStaleBridge(loadError)) return <StaleBridge what="this page" />;
    if (loadError) return <div className="ma-set-err" role="alert">Couldn&apos;t read what&apos;s available: {loadError} <button type="button" className="ma-link" onClick={() => void load()}>try again</button></div>;
    if (!grid) return <GridLoading />;
    return tab === "mcp" ? mcpTab() : tab === "skills" ? skillsTab() : tab === "tools" ? toolsTab() : mysticalTab();
  };

  const count: Partial<Record<AtTab, number>> = grid ? { mcp: grid.mcp.length, skills: grid.skills.length, tools: grid.tools.length, mystical: grid.mystical.length } : {};
  const levelled = tab !== "hooks";
  const levels: Level[] = chatId ? ["machine", "project", "chat"] : ["machine", "project"];
  const select = (
    <select className="ma-input at-projsel" value={picked ?? ""} aria-label="Project" onChange={(e) => setPicked(e.target.value || null)}>
      {!picked && <option value="">Pick a project</option>}
      {projects.map((p) => <option key={p.rel} value={p.rel}>{p.name}</option>)}
    </select>
  );

  return (
    <div className="at">
      <div className="at-tabs" role="tablist" aria-label="Agent tools">
        {AT_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" id={`at-tab-${t.key}`} aria-selected={tab === t.key} data-on={tab === t.key || undefined} onClick={() => setTab(t.key)}>
            {t.label}{count[t.key] !== undefined && <small>{count[t.key]}</small>}
          </button>
        ))}
      </div>

      {levelled ? (
        <div className="at-levelbar">
          <div className="at-seg" role="radiogroup" aria-label="Level">
            {levels.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={level === l} data-on={level === l || undefined}
                disabled={l === "project" && projects.length === 0} onClick={() => setLevel(l)}>{LEVEL_LABEL[l]}</button>
            ))}
          </div>
          {level === "project" && select}
          {level === "chat" && <span className="at-chatname" title={chat?.title ?? chatId ?? ""}>{chat?.title || "this chat"}</span>}
          <span className="at-levelhint">
            {level === "machine" ? "Every project and chat, unless one says otherwise."
              : level === "project" ? "Beats the machine. A chat can still beat it."
              : "The nearest level wins: this chat, then its project, then the machine."}
          </span>
        </div>
      ) : (
        <div className="at-levelbar">
          <span className="at-levelhint">Hooks have no levels: each lives in its agent&apos;s own config file. A project hook goes in</span>
          {level === "chat" && chatId
            ? <span className="at-chatname" title={chat?.title ?? ""}>this chat&apos;s project</span>
            : select}
        </div>
      )}

      {problem && (
        <div className="at-problem" role="alert">
          <span>{problem}</span>
          <button type="button" className="ma-link" aria-label="Dismiss" onClick={() => setProblem(null)}><X size={12} aria-hidden /></button>
        </div>
      )}

      <div role="tabpanel" aria-labelledby={`at-tab-${tab}`}>
        {tab === "rules" ? <RulesTab scope={scope} agents={agents} chatName={(id) => chatInfo(id)?.title ?? undefined} onOpenChat={onOpenChat} />
          : tab === "hooks" ? <HooksTab scope={scope} agents={agents} />
          : gridBody()}
      </div>
    </div>
  );
}
