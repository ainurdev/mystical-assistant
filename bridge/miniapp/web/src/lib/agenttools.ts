/* AGENT TOOLS on the phone: the shapes of bridge/agent_tools.py, rules.py, hooks_config.py and
 * mystical_dir.py, and every decision the screens make about them, in one file with no
 * imports so `node agenttools.check.ts` can run it.
 *
 * The one rule that isn't obvious is control(). The nearest level wins (bridge/tool_policy.py),
 * so a switch at Machine under a pick at This chat would write a value nothing reads, and the
 * row wouldn't move. That row names who decides and offers to clear that pick instead.
 */

export type Level = "machine" | "project" | "chat";
export type CellState = "installed" | "shared" | "on" | "off" | "login" | "cant";
export interface Cell { state: CellState; level?: string | null; why?: string }
export type Cells = Record<string, Cell>;

export interface McpTool { name: string; sensitive: boolean; on: boolean }
export interface McpItem {
  name: string; home: string; transport: "http" | "stdio"; known: boolean; holds_key: boolean; logged_in: boolean;
  cells: Cells; tools: McpTool[] | null;
}
export interface SkillItem {
  key: string; name: string; scope: "user" | "project"; home: "claude" | "agents";
  claude_only: boolean; conflict: boolean; on: boolean; cells: Cells;
}
export interface ToolItem { name: string; label: string; cells: Cells }
export interface MysticalItem { name: string; about: string; cells: Cells }
export interface AgentToolsGrid {
  agents: { id: string; label: string }[];
  mcp: McpItem[]; skills: SkillItem[]; tools: ToolItem[]; mystical: MysticalItem[]; patterns: string[];
}

export interface RuleFields { paths?: string[]; mode?: "block" | "ask"; times?: number }
export interface Rule {
  id: string; group: string; name: string; about: string; agents: string[];
  on: boolean; level: string | null; fields: RuleFields;
}
export interface RuleLogRow { at: number; session: string; rule: string; event: string; tool: string; decision: string; why: string }

export interface HookRow {
  id: string; agent: string; scope: "user" | "project"; event: string; matcher: string; type: string;
  command: string; timeout?: number | null; can_block: boolean;
}
export interface OwnHook { name: string; event: string; agent: string; about: string }
export interface HooksListing { hooks: HookRow[]; own: OwnHook[] }

export interface DirEntry {
  name: string; path: string; dir: boolean; bytes: number; at: number; files: number; kind: string;
  keep: boolean; preview: "image" | "text" | "none"; deletable: boolean;
}
export interface DirListing {
  root: string | null; total: number; entries: DirEntry[];
  groups: Record<string, { bytes: number; count: number }>; stale: string[];
}

/** Which chat and project a request is about: the chat when there is one, since its project
 *  and folder follow from it on the bridge, else the project a new chat would start in. */
export interface ToolScope { session: string | null; project: string | null }

export const scopeQuery = (s: ToolScope) =>
  s.session ? `session=${encodeURIComponent(s.session)}` : `project=${encodeURIComponent(s.project ?? "")}`;
export const scopeBody = (s: ToolScope) => (s.session ? { session_id: s.session } : { project: s.project });

// ------- levels and cells ------------------------------------------------------------

export const LEVELS: { value: Level; label: string }[] = [
  { value: "machine", label: "Machine" }, { value: "project", label: "This project" }, { value: "chat", label: "This chat" },
];
const RANK: Record<string, number> = { machine: 1, project: 2, chat: 3 };

/** The level as a person reads it. Nothing set anywhere is the default, whichever way the
 *  bridge spells that ("default" for a known server, null for the rest). */
export const levelWord = (level: string | null | undefined) =>
  LEVELS.find((l) => l.value === level)?.label ?? "Default";

/** Which levels this screen can write to: a level with nothing to attach to errors on the bridge. */
export const levelsOpen = (s: ToolScope): Record<Level, boolean> => ({
  machine: true, project: !!(s.session || s.project), chat: !!s.session,
});

export const stateWord = (state: CellState) => (state === "cant" ? "can't" : state);

/** The sentence under a state, where the word alone doesn't say what to do. */
export function stateMeaning(c: Cell): string {
  if (c.state === "installed") return "Lives in this agent. Mystical doesn't manage it.";
  if (c.state === "cant") return c.why || "This agent can't do it.";
  if (c.state === "login") return "Needs a login first. Log in on the dashboard: it has to finish in a browser on that machine.";
  return "";
}

export const isOn = (c: Cell) => c.state === "on" || c.state === "shared" || c.state === "login";

export type Control =
  | { kind: "none" }
  | { kind: "switch"; on: boolean; clear: boolean }
  | { kind: "decided"; by: Level };

/** What a row offers at the level picked at the top. See this file's header. */
export function control(c: Cell, chosen: Level): Control {
  if (c.state === "installed" || c.state === "cant") return { kind: "none" };
  const here = RANK[c.level ?? ""] ?? 0;
  if (here > RANK[chosen]) return { kind: "decided", by: c.level as Level };
  return { kind: "switch", on: isOn(c), clear: here === RANK[chosen] };
}

/** A row while its change is on the way: what the bridge will say once it lands. */
export function withPick(c: Cell, section: string, on: boolean, level: Level): Cell {
  return { ...c, state: on ? (section === "mcp" ? "shared" : "on") : "off", level };
}

const SUMMARY_ORDER: CellState[] = ["installed", "shared", "on", "login", "off", "cant"];

/** A closed row's line: "1 installed · 2 off". Counts, so five agents still fit at 390. */
export function summarize(cells: Cells): string {
  const n: Partial<Record<CellState, number>> = {};
  for (const c of Object.values(cells)) n[c.state] = (n[c.state] ?? 0) + 1;
  return SUMMARY_ORDER.filter((s) => n[s]).map((s) => `${n[s]} ${stateWord(s)}`).join(" · ");
}

export const matches = (q: string, ...fields: (string | undefined)[]) => {
  const t = q.trim().toLowerCase();
  return !t || fields.some((f) => f?.toLowerCase().includes(t));
};

// ------- rules -----------------------------------------------------------------------

export const ruleCell = (r: Rule): Cell => ({ state: r.on ? "on" : "off", level: r.level });

/** The groups in the catalog's order, which is the bridge's order of first appearance. */
export function ruleGroups(rules: Rule[]): { group: string; rules: Rule[] }[] {
  const out: { group: string; rules: Rule[] }[] = [];
  for (const r of rules) {
    const g = out.find((x) => x.group === r.group);
    if (g) g.rules.push(r);
    else out.push({ group: r.group, rules: [r] });
  }
  return out;
}

export const ruleHasFields = (r: Rule) => Object.keys(r.fields).length > 0;

/** A rule's settings in one line, so a closed row shows what it's doing. */
export function ruleFieldsLine(f: RuleFields): string {
  const parts: string[] = [];
  if (f.mode) parts.push(f.mode === "ask" ? "asks first" : "blocks");
  if (f.paths) parts.push(f.paths.length ? f.paths.join(", ") : "no paths yet");
  if (f.times !== undefined) parts.push(`after ${f.times} in a row`);
  return parts.join(" · ");
}

export const parsePaths = (text: string) => text.split("\n").map((p) => p.trim()).filter(Boolean);

/** The bridge clamps to 1..100 and a non-number is a 500 waiting to happen, so it's settled here. */
export function clampTimes(text: string, fallback: number): number {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? fallback : Math.max(1, Math.min(n, 100));
}

// ------- the .mystical folder --------------------------------------------------------

export const KINDS: { kind: string; label: string; about: string }[] = [
  { kind: "images", label: "Images", about: "Pictures in your messages" },
  { kind: "docs", label: "Docs", about: "Reports and other Markdown" },
  { kind: "drafts", label: "Drafts", about: "Design drafts and mockups" },
  { kind: "scratch", label: "Scratch", about: "Throwaway scripts and probes" },
  { kind: "learn", label: "Learn", about: "Saved lessons" },
  { kind: "bridge", label: "Mystical", about: "Mystical's own files" },
  { kind: "other", label: "Other", about: "Fits no kind" },
];

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n, i = -1;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** A group's count in files: the bridge's own counts entries, and images is one entry, its folder. */
export function filesIn(entries: DirEntry[], kind: string): string {
  const n = entries.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.files, 0);
  return `${n} file${n === 1 ? "" : "s"}`;
}

/** Epoch seconds as an age. */
export function ago(at: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - at);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** What GET chat-images/file wants: the address is relative to the project, not to .mystical. */
export const dirAddress = (rel: string) => `.mystical/${rel}`;

/** Whether a keep mark would change anything. Clearing only ever looks at top-level "other"
 *  entries and the direct children of scratch (mystical_dir.stale), so a keep anywhere else
 *  is a switch that does nothing, and the bridge ignores one on scratch itself. */
export function canKeep(e: DirEntry): boolean {
  const depth = e.path.split("/").length;
  return (e.kind === "other" && depth === 1) || (e.kind === "scratch" && depth === 2);
}

export const needsImageConfirm = (e: DirEntry) => e.kind === "images";

/** A group whose one entry is its folder opens that folder: "images" holding only "images/". */
export function groupOpensFolder(entries: DirEntry[]): DirEntry | null {
  return entries.length === 1 && entries[0].dir ? entries[0] : null;
}

export function deleteWords(e: DirEntry): string {
  const files = `${e.files} file${e.files === 1 ? "" : "s"}`;
  if (e.kind === "images") {
    return e.dir
      ? `Old chats show these images. Delete the folder and its ${files}? Those chats will read "image not found" where they were.`
      : `Old chats show this image. Delete it? Those chats will read "image not found" where it was.`;
  }
  return e.dir ? `Deletes the folder and its ${files}. This can't be undone.` : "This can't be undone.";
}

export interface StaleRow { path: string; bytes: number | null; at: number | null }

/** The route names what clearing would take by path; sizes come from the listings the screen
 *  already holds. A path no listing covers shows no size rather than a made-up one. */
export function staleRows(paths: string[], known: DirEntry[]): { rows: StaleRow[]; total: number; complete: boolean } {
  const rows = paths.map((path) => {
    const e = known.find((k) => k.path === path);
    return { path, bytes: e?.bytes ?? null, at: e?.at ?? null };
  });
  return {
    rows,
    total: rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
    complete: rows.every((r) => r.bytes !== null),
  };
}

// ------- errors ----------------------------------------------------------------------

/** A failure as a sentence. The bridge's own errors are already sentences; the two that
 *  aren't are a bare 404 (the running bridge is older than this page, and a restart is what's
 *  missing) and no connection. */
export function errorWords(status: number, message: string): string {
  if (status === 0) return "Can't reach the bridge.";
  if (status === 404 && /^not found$/i.test(message.trim())) {
    return "The running bridge doesn't have this yet. Go live with ⟳ on the dashboard.";
  }
  return message;
}
