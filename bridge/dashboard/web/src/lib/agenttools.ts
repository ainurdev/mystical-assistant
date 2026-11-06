// SETTINGS ▸ Agent Tools, the pure half: what a cell says, what a click does, who a rule
// reaches. bridge/agent_tools.py joins the sources and bridge/tool_policy.py holds the
// levels; nothing here decides anything they don't. A cell only repeats their answer in
// plain words, so every surface reads the same. No React and no fetch: agenttools.check.ts
// runs this file on its own.

export type Level = "machine" | "project" | "chat";
export type Section = "mcp" | "skills" | "tool" | "mystical";
export type CellState = "installed" | "shared" | "on" | "off" | "login" | "cant";

export interface Cell { state: CellState; level?: string | null; why?: string }
export interface AgentRef { id: string; label: string }
export interface McpToolRow { name: string; sensitive: boolean; on: boolean }
export interface McpGridRow {
  name: string; home: string; transport: string; known: boolean; holds_key: boolean; logged_in: boolean;
  cells: Record<string, Cell>; tools: McpToolRow[] | null;
}
export interface SkillGridRow {
  key: string; name: string; scope: string; home: string; claude_only: boolean; conflict: boolean; on: boolean;
  cells: Record<string, Cell>;
}
export interface ToolGridRow { name: string; label: string; cells: Record<string, Cell> }
export interface MysticalGridRow { name: string; about: string; cells: Record<string, Cell> }
export interface ToolGrid {
  agents: AgentRef[]; mcp: McpGridRow[]; skills: SkillGridRow[]; tools: ToolGridRow[]; mystical: MysticalGridRow[];
  patterns: string[]; caps: Record<string, Record<string, unknown>>;
}

/** Where a pick lands and what a read sees. A project or chat travels only at its level. */
export interface Scope { level: Level; project: string | null; session: string | null }

export function scopeQuery(s: Scope): string {
  const q = new URLSearchParams();
  if (s.level === "project" && s.project) q.set("project", s.project);
  if (s.level === "chat" && s.session) q.set("session", s.session);
  const text = q.toString();
  return text ? `?${text}` : "";
}

export function scopeBody(s: Scope): { level: Level; project?: string; session_id?: string } {
  if (s.level === "project" && s.project) return { level: "project", project: s.project };
  if (s.level === "chat" && s.session) return { level: "chat", session_id: s.session };
  return { level: s.level };
}

/** Hooks have no levels, but a project's own file still needs a project: it's the picked
 *  one whatever the level, or the open chat's. */
export function hookQuery(s: Scope): string {
  const q = new URLSearchParams();
  if (s.level === "chat" && s.session) q.set("session", s.session);
  else if (s.project) q.set("project", s.project);
  const text = q.toString();
  return text ? `?${text}` : "";
}
export function hookBody(s: Scope): { project?: string; session_id?: string } {
  if (s.level === "chat" && s.session) return { session_id: s.session };
  return s.project ? { project: s.project } : {};
}

export const STATE_WORD: Record<CellState, string> = {
  installed: "INSTALLED", shared: "SHARED", on: "ON", off: "OFF", login: "LOG IN", cant: "CAN'T",
};
const LEVEL_NAME: Record<string, string> = { machine: "this machine", project: "this project", chat: "this chat" };
export const LEVEL_LABEL: Record<Level, string> = { machine: "Machine", project: "This project", chat: "This chat" };

/** The small tag: who set it. Installed and can't have nobody to name. */
export function levelTag(cell: Cell): string {
  if (cell.state === "installed" || cell.state === "cant") return "";
  return (cell.level || "default").toUpperCase();
}

/** A switch that does something. Everything else opens the row, which says why. */
export function isToggle(cell: Cell): boolean {
  return cell.state === "on" || cell.state === "off" || cell.state === "shared" || cell.state === "login";
}

/** What a click asks for: the opposite of what the cell reads. A login cell is a share
 *  waiting on a login, so a click there logs in rather than flips (see gridClick). */
export function nextOn(cell: Cell): boolean {
  return cell.state === "off";
}

export type GridClick = "toggle" | "login" | "open";
export function gridClick(cell: Cell): GridClick {
  if (cell.state === "login") return "login";
  return isToggle(cell) ? "toggle" : "open";
}

/** Reset means "this level stops saying anything": only where this level said it, and a
 *  skill has no levels (it's one symlink for the whole machine). */
export function canReset(section: Section, cell: Cell, level: Level): boolean {
  return section !== "skills" && isToggle(cell) && cell.level === level;
}

function setBy(cell: Cell, section: Section): string {
  if (section === "skills") return "A skill's share is one folder link, so it holds for this whole machine at every level.";
  if (cell.level === "default") return "Nothing is picked, and Mystical knows this one works on local or public data, so it's on by default.";
  if (cell.level && LEVEL_NAME[cell.level]) return `Set for ${LEVEL_NAME[cell.level]}.`;
  return "Nothing is picked at any level, so the default applies.";
}

/** The tooltip and the row's line for an agent: the same plain words. */
export function cellWhy(section: Section, cell: Cell, agent: string): string {
  switch (cell.state) {
    case "installed": return `It lives in ${agent}. Mystical doesn't manage it.`;
    case "cant": return cell.why || `${agent} can't do this.`;
    case "login": return `Shared with ${agent}, but it needs its own login first. ${setBy(cell, section)}`;
    case "shared": return `Another agent's, reaching ${agent} through Mystical. ${setBy(cell, section)}`;
    case "on": return `On for ${agent}. ${setBy(cell, section)}`;
    default: return `Off for ${agent}. ${setBy(cell, section)}`;
  }
}

/** A remote server with no key and no known home: it can't reach anyone until it logs in. */
export function mcpNeedsLogin(r: Pick<McpGridRow, "transport" | "holds_key" | "known" | "logged_in">): boolean {
  return r.transport === "http" && !r.holds_key && !r.known && !r.logged_in;
}

/** The first-share warning's key, kept per browser: the bridge has no record of a first share. */
export const shareKey = (name: string, agent: string) => `${name}|${agent}`;

export function matches(q: string, ...parts: (string | null | undefined)[]): boolean {
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** A why that every row of a column shares is the column's fact: said once, over the grid,
 *  rather than wrapped into every cell. A why only some rows have stays on those rows. */
export function columnNotes(rows: { cells: Record<string, Cell> }[], agents: AgentRef[]): { agent: string; why: string }[] {
  const out: { agent: string; why: string }[] = [];
  if (!rows.length) return out;
  for (const a of agents) {
    const whys = new Set(rows.map((r) => (r.cells[a.id]?.state === "cant" ? r.cells[a.id].why || "" : null)));
    const [only] = [...whys];
    if (whys.size === 1 && only) out.push({ agent: a.label, why: only });
  }
  return out;
}

/** The grid as it will read after a pick, before the bridge has answered. */
export function patchCell<R extends { cells: Record<string, Cell> }>(
  rows: R[], same: (r: R) => boolean, agent: string, cell: Partial<Cell>,
): R[] {
  return rows.map((r) => (same(r) && r.cells[agent] ? { ...r, cells: { ...r.cells, [agent]: { ...r.cells[agent], ...cell } } } : r));
}

/** The state word for a pick in this section: a server or a skill is shared, a tool is on. */
export function pickedState(section: Section, on: boolean): CellState {
  if (!on) return "off";
  return section === "mcp" || section === "skills" ? "shared" : "on";
}

/** A chat's own ⚒ Tools switch reads as the chat level, but it's not a pick: tool-policy
 *  can't clear it, and the run denies it whatever a pick says. So that cell doesn't flip
 *  here, it says where it lives. */
export function heldByChatSwitch(section: Section, name: string, cell: Cell, scope: Scope, disabled: string[] | null | undefined): boolean {
  return section === "tool" && scope.level === "chat" && cell.state === "off" && cell.level === "chat" && !!disabled?.includes(name);
}

// ---- pattern rules --------------------------------------------------------------

/** What a level holds itself, given what's in force here and at the next level out. The
 *  route only answers with the merged list, nearest first; a pattern both levels have reads
 *  as the wider one's, and dropping it from this level changes nothing that runs. */
export function ownPatterns(here: string[], wider: string[]): string[] {
  const out = new Set(wider);
  return here.filter((p) => !out.has(p));
}

/** bridge/tool_policy.set_patterns drops these silently, so the field says first. */
export function patternProblem(p: string, existing: string[]): string | null {
  const v = p.trim();
  if (!v) return "Type a pattern first.";
  if (v.length >= 200) return "That's too long: a pattern has to be under 200 characters.";
  if (!/^[A-Za-z]/.test(v)) return "A pattern starts with a tool's name, like Bash(git push*).";
  if (existing.includes(v)) return "That one's already there.";
  return null;
}

// ---- rules ----------------------------------------------------------------------

export interface RuleFields { paths?: string[]; mode?: string; times?: number }
export interface RuleRow {
  id: string; group: string; name: string; about: string; agents: string[];
  on: boolean; level: string | null; fields: RuleFields;
}
export interface RuleLogRow { at: number; session: string; rule: string; event: string; tool: string; decision: string; why: string }

export const RULE_GROUPS = ["Safety", "Quality", "Context", "Visibility"];

export function groupRules(rows: RuleRow[]): { group: string; rows: RuleRow[] }[] {
  const known = RULE_GROUPS.map((group) => ({ group, rows: rows.filter((r) => r.group === group) }));
  const rest = [...new Set(rows.map((r) => r.group))].filter((g) => !RULE_GROUPS.includes(g))
    .map((group) => ({ group, rows: rows.filter((r) => r.group === group) }));
  return [...known, ...rest].filter((g) => g.rows.length);
}

/** Why an agent isn't on a rule's list: each one's own reason, from bridge/rules.py. */
const NOT_ON: Record<string, Record<string, string>> = {
  mask_secrets: { kimi: "Kimi can't replace a tool's output." },
  pack_after_compact: { claude: "Claude keeps these in its system prompt already." },
};

const nameOf = (id: string, agents: AgentRef[]) => agents.find((a) => a.id === id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);

/** Who a rule acts on here, and the plain note where an agent can only do part of it. */
export function ruleReach(rule: Pick<RuleRow, "id" | "agents" | "fields">, agents: AgentRef[], level: Level): { acts: string; notes: string[] } {
  const here = new Set(agents.map((a) => a.id));
  const acts = rule.agents.map((id) => `${nameOf(id, agents)}${here.has(id) ? "" : " (not installed)"}`).join(" · ");
  const notes: string[] = [];
  for (const a of agents) {
    const why = NOT_ON[rule.id]?.[a.id];
    if (why && !rule.agents.includes(a.id)) notes.push(why);
  }
  const kimi = rule.agents.includes("kimi") && here.has("kimi");
  if (kimi && rule.fields.mode !== undefined) notes.push("Kimi can only block: asking you first works on Claude.");
  if (kimi && level === "chat") {
    notes.push("Kimi's hooks are per login, not per chat. Switched on only here, this rule reaches Kimi once it's on at a project or the machine too.");
  }
  return { acts, notes };
}

/** Agents no rule can act on: said once, over the tab, not on every rule. */
export function agentsNoRuleReaches(rules: Pick<RuleRow, "agents">[], agents: AgentRef[]): AgentRef[] {
  if (!rules.length) return [];
  return agents.filter((a) => !rules.some((r) => r.agents.includes(a.id)));
}

/** The whole row goes up on any change: a level's pick replaces the wider one's fields. */
export function ruleWrite(rule: RuleRow, patch: { on?: boolean; fields?: RuleFields }): { id: string; on: boolean; fields: RuleFields } {
  return { id: rule.id, on: patch.on ?? rule.on, fields: { ...rule.fields, ...patch.fields } };
}

// ---- hooks ----------------------------------------------------------------------

export interface HookRow {
  id: string; agent: string; scope: string; event: string; matcher: string; type: string; command: string;
  timeout: number | null; can_block: boolean; editable: boolean;
}
export interface OwnHook { name: string; event: string; agent: string; about: string }
export interface HookListing {
  hooks: HookRow[]; own: OwnHook[]; events: Record<string, string[]>; can_block: Record<string, string[]>;
}

/** Where a hook can be copied: another agent that's here and has the event, and doesn't
 *  have this hook already. Only a command: a prompt or URL hook would arrive as a shell
 *  command made of its text. */
export function copyTargets(h: HookRow, list: HookListing, agents: AgentRef[]): AgentRef[] {
  if (!h.editable) return [];
  return agents.filter((a) => a.id !== h.agent && (list.events[a.id] ?? []).includes(h.event)
    && !list.hooks.some((x) => x.agent === a.id && x.event === h.event && x.matcher === h.matcher && x.command === h.command));
}

export function hookAgents(list: HookListing, agents: AgentRef[]): AgentRef[] {
  const ids = new Set(agents.map((a) => a.id));
  return Object.keys(list.events)
    .filter((id) => ids.has(id) || list.hooks.some((h) => h.agent === id))
    .map((id) => ({ id, label: nameOf(id, agents) }));
}

/** Bridge's refusals come back as they are; this only stops a form that can't be sent. */
export function hookProblem(f: { event: string; command: string; timeout: string }): string | null {
  if (!f.event) return "Pick an event.";
  if (!f.command.trim()) return "A hook needs a one-line command.";
  if (f.timeout.trim() && !/^[1-9]\d*$/.test(f.timeout.trim())) return "A timeout is a whole number of seconds.";
  return null;
}

// ---- getting here ---------------------------------------------------------------

export type AtTab = "mcp" | "skills" | "tools" | "mystical" | "rules" | "hooks";
export const AT_TABS: { key: AtTab; label: string }[] = [
  { key: "mcp", label: "MCP" }, { key: "skills", label: "Skills" }, { key: "tools", label: "Tools" },
  { key: "mystical", label: "Mystical tools" }, { key: "rules", label: "Rules" }, { key: "hooks", label: "Hooks" },
];

/** openSettings("agenttools", atFocus(...)): where the page opens. */
export interface AtFocus { tab?: AtTab; level?: Level; session?: string; project?: string }
export const atFocus = (f: AtFocus): string => JSON.stringify(f);
export function parseFocus(raw: string | null | undefined): AtFocus {
  if (!raw) return {};
  try {
    const f = JSON.parse(raw) as unknown;
    return f && typeof f === "object" ? (f as AtFocus) : {};
  } catch { return {}; }
}

/** A settings search hit names a section; this is the tab that holds it now. */
const SEC_TAB: Record<string, AtTab> = {
  "MCP SERVERS": "mcp", "ADD A SERVER": "mcp", "SHARED MCP SERVERS": "mcp", MCP: "mcp",
  SKILLS: "skills", "SHARED SKILLS": "skills", "BUILT-IN TOOLS": "tools", "PATTERN RULES": "tools",
  "MYSTICAL TOOLS": "mystical", RULES: "rules", HOOKS: "hooks",
};
export const secTab = (sec: string | null | undefined): AtTab | undefined => (sec ? SEC_TAB[sec] : undefined);

/** The folder a picked project's rows live in, for the two older routes that want a path:
 *  the open chat's, else any of its sessions'. A project with no session has none to give,
 *  and only its project-level servers and skills feel that. */
export function cwdOf(scope: Scope, sessionCwd: string | null | undefined, projectCwd: (rel: string) => string | null | undefined): string | null {
  if (scope.level === "chat") return sessionCwd ?? null;
  if (scope.project) return projectCwd(scope.project) ?? null;
  return null;
}

export const levelTagOf = (level: string | null | undefined): string => (level || "default").toUpperCase();
