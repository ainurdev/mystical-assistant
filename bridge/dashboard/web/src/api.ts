// The dashboard server hands out a per-process token in the URL the user opens
// (http://127.0.0.1:8790/?token=...). We keep it and send it on every
// state-changing request (X-Dash-Token) and on SSE streams (?token=). Cross-origin
// pages can't read it, which (with the server's Host allow-list) is the CSRF defense.
const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") ?? "";
// The server injects window.__DASH_AUTH_REQUIRED__ into index.html. It is false
// when the gate is disabled (DASH_TOKEN=""), so the dashboard opens with no
// ?token=. Absent (e.g. the vite dev server) → treat as not required.
export const AUTH_REQUIRED =
  (window as Window & { __DASH_AUTH_REQUIRED__?: boolean }).__DASH_AUTH_REQUIRED__ === true;

export interface Project {
  rel: string;
  name: string;
}
// Why a session is out of the active list. null = still active.
export type Lifecycle = "done" | "abandoned" | "backlog";
// An objective the session keeps working on. The model owns the verdict (it calls
// UpdateGoal); the bridge re-prompts after each turn while state is "active".
export interface Goal {
  objective: string;
  state: "active" | "complete" | "blocked";
  iter: number;
  note?: string;
}
export interface SessionBrief {
  id: string;
  title: string | null;
  project: string;
  updated: number;
  archived: number;
  origin?: string | null; // where it started: vscode | dashboard | miniapp | bot | null
  cwd?: string | null; // run dir — a linked worktree differs from the project dir
  branch?: string; // the session's git branch (worktree branch, or the project's)
  fallback_policy?: string | null; // on usage limit: ask | auto | wait | null (default)
  ctx_tokens?: number | null; // window fill at the end of the last turn (null = unmeasured)
  ctx_window?: number; // what ctx_tokens is a fraction of (config.CONTEXT_WINDOW)
  autocompact?: string | null; // compact at: "auto" | token count | null (claude's default)
  disabled_tools?: string[]; // claude deny rules — tools/MCP servers switched off here
  goal?: Goal | null;
  lifecycle?: Lifecycle | null; // null = active; anything else is why it's hidden
  tags?: string[]; // topic tags, written by the titler's existing one-shot
}
export interface StoreTurn {
  id: string;
  seq: number;
  prompt: string;
  attachments: string[];
  status: "running" | "done" | "error";
  cost: number | null;
  elapsed: number | null;
  started: number;
  runtime?: string | null; // null = default Claude account; 'claude:<slot>' | 'opencode:<provider>'
  sha?: string | null;     // commit HEAD was on when the turn started (checkpoint drift)
  // What the turn spent. All four null = never reported (unknown, not zero).
  tok_in?: number | null;
  tok_out?: number | null;
  tok_cache_w?: number | null;
  tok_cache_r?: number | null;
}

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}
export interface AnswerSelection {
  header: string;
  labels: string[];
  notes?: string;   // free text when the prepared options don't fit
}

export type RunEvent =
  | { type: "text"; text: string }
  // A pause where the model reasoned: `text` is the reasoning as recorded (Claude
  // Code keeps it on the stream and on disk, it just never prints it) and `ms` is
  // how long the pause ran. A block whose text was stripped, leaving a signature,
  // carries `ms` alone — and only when the pause was long enough to have been sat
  // through (bridge/transcript_jsonl.py THINK_MIN_MS).
  | { type: "thinking"; ms?: number; text?: string }
  // The working output either side of the conversation: a hook that injected
  // context, blocked a tool or crashed, and whatever the claude child wrote to
  // stderr (normally nothing — a dying MCP server, or --debug).
  | { type: "log"; src: "hook" | "stderr"; label?: string; text: string; error?: boolean }
  | { type: "tool"; name: string; summary: string; id?: string }
  // `output`/`is_error` are Bash-only, `patch` edit-only (see
  // transcript_jsonl.tool_done); turns recorded before this landed carry no `id`.
  | {
      type: "tool_done";
      id?: string;
      ms?: number;
      output?: string;
      is_error?: boolean;
      patch?: string[];
      // How big the answer was ("512 lines", "14 tools · 32.1k tokens"), or the
      // first line of the error when the call failed — for the tools whose output
      // isn't stored, which is everything but Bash and edits.
      stat?: string;
      // Screenshots a tool returned, as upload-dir paths (see /local/attachment).
      images?: string[];
    }
  // `is_error` landed later — turns recorded before it read as OK.
  | { type: "result"; result: string; cost: number; elapsed: number; is_error?: boolean }
  | { type: "error"; message: string }
  | { type: "stopped" }
  // `images`: screenshots sent with the steer, as upload-dir paths (same as
  // tool_done's). Steers recorded before this landed carry none.
  | { type: "steer"; text: string; images?: string[] }
  | { type: "permission"; request_id: string; tool_name: string; summary: string }
  | { type: "question"; request_id: string; questions: Question[] }
  | { type: "permission_resolved"; request_id: string; behavior: "allow" | "deny" }
  | { type: "question_answered"; request_id: string; answers: AnswerSelection[] };

export type StoreEvent = RunEvent & { seq: number; turn_id: string };

export interface Transcript {
  session: SessionBrief | null;
  turns: StoreTurn[];
  events: StoreEvent[];
  next_cursor: number;
  /** What the live turn is waiting on before its first token ("starting Claude",
   *  "checking configured MCP servers"). Absent once it speaks — this is a live
   *  status, never a recorded event. */
  boot?: string | null;
  // Present only when the request carried ?tail= (and the server is new enough
  // to window) — older turns exist beyond the first loaded one.
  has_older?: boolean;
  /** Oldest loaded event seq — the `before` key for the next older page. */
  oldest_seq?: number | null;
  /** First turn whose events are loaded — where rendering should start. */
  tail_from?: string | null;
}

export interface ServerInfo {
  status: "running" | "exited" | "not started";
  cmd: string | null;
  dir: string | null;
  pid: number | null;
}
// One concurrent dev server, keyed by run directory. `url`/`port` are the
// localhost the framework actually bound (detected from its output).
export interface DevServerInfo {
  status: "running" | "exited" | "not started";
  cmd: string | null;
  dir: string | null;       // run dir, as a rel path
  pid: number | null;
  url: string | null;       // detected http://localhost:<port>
  port: number | null;
  project: string;          // canonical project rel (for grouping/label)
  branch: string;
  tail: string[];           // recent log lines (for status/errors)
}
// Identifies which run directory + branch a request targets.
export interface RunCtx {
  cwd?: string | null;      // absolute worktree dir (from a session)
  cwd_rel?: string | null;  // rel run dir (from the running-servers list)
  project?: string | null;  // canonical project rel; resolution fallback + label
  branch?: string | null;
}
export interface DashState {
  project: Project | null;
  server: ServerInfo;
  servers?: DevServerInfo[]; // all concurrent dev servers
  dev_port?: number; // legacy default dev-server port (config.PREVIEW_PORT)
  permission_mode?: string | null;
  models?: { id: string; label: string }[]; // live list from GET /v1/models (bridge/models.py)
}
export interface ProjectsListing {
  rel: string;
  at_base: boolean;
  can_up: boolean;
  dirs: string[];
  projects?: string[]; // git repos under BASE_PATH, org-folder nesting included
  hidden?: string[]; // rels the bridge remembers as HIDDEN (project_config.json)
}

export interface GitFile {
  path: string;
  status: string;
  add: number;
  del: number;
  // Porcelain's raw pair: `x` is the index (staged) state, `y` the working
  // tree's, "." meaning unchanged, "?" untracked. Absent on an old backend
  // that hasn't restarted yet — CHANGES then treats everything as unstaged.
  x?: string;
  y?: string;
}
export interface GitStatus {
  is_repo: boolean;
  branch: string;
  // "origin/main" when the branch tracks a remote, "" when it only exists
  // locally. Absent on an old backend that hasn't restarted yet.
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: number;
  files: GitFile[];
}
// One node of the commit graph — `parents` is what the lane layout walks.
export interface GitCommit {
  sha: string;
  parents: string[];
  author: string;
  ts: number;
  refs: string[]; // decorations: "HEAD -> main", "origin/main", "tag: v1.2"
  subject: string;
}
export interface GitBadge {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: number;
  branches?: number; // local branch count (absent until the bridge restarts on an old backend)
  worktrees?: number; // linked worktrees, main checkout excluded
}

// A working-tree file loaded into the EDITOR tab. `content` is empty when the
// file is binary or over the size cap (the editor shows a placeholder instead).
export interface FileContent {
  ok: boolean;
  path?: string;
  content?: string;
  binary?: boolean;
  too_large?: boolean;
  size?: number;
  // Images, PDFs, video and audio come back as a data URL the browser renders
  // in place of the buffer, plus the mime that picks the element.
  media?: string;
  mime?: string;
  error?: string;
  // Indent rules for this path, resolved from .editorconfig with a per-language
  // fallback (bridge/fmt.py), plus whether a formatter is installed for it.
  indent?: string;
  tab_size?: number;
  trim_trailing_whitespace?: boolean;
  insert_final_newline?: boolean;
  formatter?: boolean;
}

// One search-in-files match from `git grep` (EDITOR palette `#` mode).
export interface GrepHit {
  path: string;
  line: number;
  text: string;
}
export type FileOp = "new" | "newdir" | "rename" | "delete";

export interface GitHubLabel {
  name: string;
  color: string;
}
export interface Issue {
  number: number;
  title: string;
  url: string;
  updated: string;
  body: string;
  labels: GitHubLabel[];
}
export interface IssuesInfo {
  has_remote: boolean;
  slug: string | null;
  gh_ok: boolean;
  error: string;
  open_count: number;
  closed_count: number;
  issues: Issue[];
}

export interface ProjectSettings {
  scripts: Record<string, string>;
  run_cmd: string | null;
  prod_url: string | null;
  design_project: string | null;
  default_cmd: string;
  log_path: string;
}

export type ModelId = string; // full model id from the Models API, or a short CLI alias
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

// One prompt in a session's prompt queue. `text` is the human
// instruction shown in the UI; the full composed prompt that runs stays server-side.
export interface QueueItem {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  text: string;
  sel: { tag: string; label: string }[];
  width: number;
  surface: string;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  job_id: string | null;
  result: string | null;
  error: string | null;
  cost: number | null;
  elapsed: number | null;
  created: number;
  started: number | null;
}
// The whole per-session queue. `seq` is a revision counter (SSE dedup); the
// server publishes a fresh snapshot on every change.
/** A tag and how many sessions wear it (SETTINGS · TAGS manages these). */
export interface TagCount {
  tag: string;
  count: number;
}

export interface QueueSnapshot {
  session_id: string;
  seq: number;
  paused: boolean;
  items: QueueItem[];
}
export type QueueOp =
  | "remove" | "edit" | "reorder" | "bump" | "move"
  | "pause" | "resume" | "cancel" | "retry" | "clear-done"
  | "steer";   // not a queue mutation — folds text into the running turn

// Host vitals (psutil) for the WORKSPACE panel.
export interface HostStats {
  available: boolean;
  host: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  mem_pct: number;
  net_up: number; // KB/s
  net_down: number; // KB/s
  load: number;
  procs: number;
  state: "NOMINAL" | "BUSY" | string;
}
export interface Weather {
  available: boolean;
  temp: number | null;
  cond: string;
  hi: number | null;
  lo: number | null;
  wind: string;
  hum: string;
  unit: "C" | "F";
  loc: string;
}
export interface Worktree {
  path: string;
  rel: string | null;
  branch: string;
  head: string;
  detached: boolean;
  is_main: boolean;
}
export interface CompareFile {
  name: string;
  mark: string; // A | M | D | R …
  add: number;
  del: number;
}
export interface CompareInfo {
  ok: boolean;
  commits: number;
  ahead: number;
  behind: number;
  files: CompareFile[];
  add: number;
  del: number;
}

export type AgentInfo = {
  agent_id: string;
  agent_type: string;
  description: string;
  tool_use_id: string;
  spawn_depth: number;
  status: "running" | "done";
  started_at: number;
  updated_at: number;
};
export type WorkflowAgentInfo = {
  agent_id: string;
  agent_type: string;
  description: string;
  run_id: string;
  status: "running" | "done";
  started_at: number;
  updated_at: number;
};
export type WorkflowInfo = {
  run_id: string;
  name: string;
  status: "running" | "done";
  agent_count: number;
  total_tokens: number;
  total_tool_calls: number;
  duration_ms: number;
  summary: string;
  agents: WorkflowAgentInfo[];
};
export type AgentsInfo = {
  running: number;
  total: number;
  agents: AgentInfo[];
  workflows: WorkflowInfo[];
};
export type AgentActivityEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string };
export type AgentActivity = {
  events: AgentActivityEvent[];
  next_cursor: number;
  status: "running" | "done";
  description: string;
  agent_type: string;
};

export type RunningSource = "bridge" | "vscode" | "cli" | "sdk" | string;
export interface RunningSession {
  session_id: string;
  pid: number;
  project: string;
  cwd: string;
  source: RunningSource;
  started: number | null; // epoch seconds
  last_active: number | null; // epoch seconds — file mtime, activity signal
  status: string | null;
  waiting_for: string | null;
  state?: SessionState; // "working" while its transcript is being written, else "idle"
}
export interface AwaitingSession {
  session_id: string;
  kind: "question" | "permission";
}
// working = transcript being written right now; live = native session recently
// active (alive but briefly paused); awaiting = blocked on you; checking = a
// prompt of yours is being checked against this session; parked = killed by a
// usage limit or API error and waiting to auto-resume; asking = the last turn
// finished by asking you something (the transcript's ASK card) — your move, but
// nothing is blocked; else idle.
export type SessionState =
  "working" | "awaiting" | "checking" | "parked" | "asking" | "live" | "idle";
// One unified per-session status, identical on every surface. Bridge sessions can
// be any state; native (VS Code/terminal) sessions are working/idle only.
export interface SessionStatus {
  state: SessionState;
  // question/permission on `awaiting`; limit/server on `parked`.
  kind: "question" | "permission" | "limit" | "server" | null;
  source: "bridge" | "native";
  label: string | null;
}
export interface JobActivity {
  state: "tool" | "awaiting" | "thinking";
  label: string;
  kind?: "question" | "permission";
  tools: number;
}
export interface RunningJob {
  session_id: string | null;
  job_id: string;
  project: string | null;
  title: string | null;
  started: number | null;
  activity: JobActivity;
}
export interface RunningInfo {
  external: RunningSession[];
  bridge_running: string[];
  jobs: RunningJob[]; // this chat's live bridge runs, with activity detail
  awaiting: AwaitingSession[]; // sessions blocked on your answer/approval
  status: Record<string, SessionStatus>; // unified per-session status (working/awaiting only)
}
export interface EnrichedSession {
  id: string;
  title: string | null;
  project: string;
  origin?: string | null; // where it started: vscode | dashboard | miniapp | bot | null
  created: number;
  updated: number;
  archived: number;
  lifecycle?: Lifecycle | null; // why it left the active list; null = still in it
  turn_count: number;
  total_elapsed: number; // seconds of wall clock across the session's turns
  total_tokens: number | null; // null = no turn reported usage (unknown, not free)
  last_activity: number;
  models: string[];
}
/** One tool's share of a session's wall clock. `union_s` counts overlapping calls
 *  once; `naive_s` just adds durations. Equal values mean the tool never ran
 *  concurrently with itself — which is what says whether parallelising is on the
 *  table. */
export interface ToolSpend {
  calls: number;
  union_s: number;
  naive_s: number;
  avg_s: number;
  unfinished: number; // started, never finished — the turn was killed mid-call
}

/** Where a session's time and tokens went. Dollars are deliberately absent: the
 *  CLI prices runs off API list rates while these go through a subscription. */
export interface SessionBreakdown {
  wall: number; // seconds across the session's turns
  tools: Record<string, ToolSpend>;
  thinking_s: number;
  waiting_s: number; // AskUserQuestion — a human deciding, not the session being slow
  model_s: number; // the remainder: generating
  tokens: { in: number; out: number; cache_w: number; cache_r: number } | null;
  capped: number; // turns the per-turn time cap killed
  turns: number;
}
export interface UsageBucket {
  percent: number;
  resets_at: string | null;
  severity: string;
}
export interface AccountInfo {
  slot: number;
  email: string | null;
  alias: string | null;
  disabled: boolean;
  default: boolean;
  left: number | null; // % of the tighter usage window unspent; null = meter unreadable
}
/** One free-agent rung — listed even unconfigured, since this is where you set it up. */
export interface FreeAgentInfo {
  provider: string;
  label: string;
  env: string; // the variable that configures it — an API key, or a model name for Ollama
  model: string;
  needs: "key" | "model";
  configured: boolean;
  source: "env" | "saved" | null;
  ready: boolean; // configured *and* opencode is installed
}
export interface FreeAgents {
  installed: boolean; // is the opencode binary there at all
  providers: FreeAgentInfo[];
}
/** One captured call to the Anthropic API. Bodies are summarized rather than
 *  stored: a request body is the whole conversation, which is already in the
 *  transcript. Credentials never reach here. */
export interface InspectorEntry {
  seq: number;
  ts: number; // unix seconds
  method: string;
  path: string;
  status?: number; // 0 = never reached upstream
  ms?: number;
  ttfb_ms?: number | null;
  request_bytes?: number;
  response_bytes?: number;
  aborted?: boolean;
  request?: {
    model?: string;
    max_tokens?: number;
    stream?: boolean;
    messages?: number;
    tools?: number;
    system_chars?: number;
    thinking?: boolean;
  };
  sse?: {
    events: Record<string, number>;
    usage: Record<string, number> | null;
    stop_reason: string | null;
  };
  body?: string;
  error?: string;
}
export interface InspectorState {
  on: boolean;
  base_url: string | null;
  entries: InspectorEntry[];
}
/** Everything a session can switch off. `rule` is the string handed to
 *  `claude --disallowedTools`, and the key we store. */
export interface Toolsets {
  builtins: { rule: string; label: string; hint: string }[];
  servers: { name: string; rule: string; ok: boolean; status: string }[];
  /** What a session that never opened this modal runs with. */
  default: string[];
}
export interface AccountsInfo {
  accounts: AccountInfo[];
  default_policy: string;
  free_agents: FreeAgents;
  pending_login: { slot: number; url: string | null } | null;
}
/** One AI-powered extra. Everything here spends a model call nobody asked for,
 *  so each ships off and is switched on from the settings modal's AI tab. */
export interface AiFeature {
  key: string;
  label: string;
  hint: string;
  cost: string;
  tokens?: string; // what one unit burns, in + out — absent on a bridge older than the figure
  about: string; // the paragraph under the switch — what it does, what it adds
  enabled: boolean;
}
/** Whether the bridge starts itself at login, from the two host-side files that
 *  arrange it (a systemd user unit and a .cmd in the Windows Startup folder).
 *  `supported: false` means this machine can't have them — `reason` says why, and
 *  the switches hide. `supervised` is the separate question of whether the bridge
 *  running *right now* is the unit's own: a hand-launched one still works, but
 *  nothing restarts it. */
export interface StartupState {
  supported: boolean;
  reason: string | null;
  login: boolean;
  window: boolean;
  supervised: boolean;
  browser: string | null; // e.g. "chrome.exe" — which one the window opens in
}
/** One environment setting, lifted out of .env so it has a switch here. The
 *  value shown is the effective one: a saved override, else what .env said, else
 *  the code default — `source` says which. A secret is returned masked. */
export interface EnvSetting {
  key: string;
  label: string;
  group: string;
  type: "bool" | "int" | "str" | "text" | "path" | "enum" | "csvint" | "secret";
  live: boolean; // false → persists now, takes effect on the next bridge start
  hint: string;
  about: string;
  value: string | number | boolean;
  source: "saved" | "env" | "default";
  default: string | number | boolean;
  choices?: string[];
  unit?: string;
  placeholder?: string;
}
export interface AgentConfigFile {
  id: string;
  name: string;
  lang: "markdown" | "json";
  hint: string;
  path: string;   // display path, $HOME collapsed to ~
  exists: boolean;
  content: string;
  error: string | null;   // unreadable/too large → the editor stays read-only
}
export interface AgentConfigTool {
  id: string;
  label: string;
  hint: string;
  installed: boolean;
  files: AgentConfigFile[];
}
export interface NextItem {
  id: string;
  title: string;
  why: string;
  effort: "small" | "medium" | "large";
  evidence: string;
  repo: string;
  branch: string;
  cwd: string; // where the session runs — a worktree differs from the project dir
  project: string; // BASE_PATH-relative project key the session groups under
  prompt: string; // composed server-side — never written by a model
}
export interface NextBoard {
  items: NextItem[];
  generated: number | null;
  repos: string[];
  refreshing: boolean;
  enabled: boolean; // false → the list is the plain heuristic order
}
/* Since local midnight, for this chat. `cost` is null when no turn in the
   window reported one — unknown, not $0.00 — and is priced at API list rate
   even on a subscription (9f612a4), so tokens are the honest number. */
export interface TodayInfo {
  turns: number;
  tokens: number;
  cost: number | null;
}

export interface UsageInfo {
  available: boolean;
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  limits?: {
    kind: string;
    group: string;
    percent: number;
    severity: string;
    resets_at: string | null;
    is_active: boolean;
    // weekly_scoped limits name the model whose own weekly cap they are
    scope?: { model?: { id: string | null; display_name: string | null } | null } | null;
  }[];
}

export type SkillScope = "project" | "system";
export type SkillCategory =
  | "development" | "design" | "writing" | "testing" | "workflow" | "other";
export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  category: SkillCategory;
  from_catalog: boolean; // false → hand-written, so the UI never offers to delete it
}
export interface CatalogSkill {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  repo: string | null; // "owner/name" — set when installing downloads it from GitHub
}
export interface SkillsInfo {
  project: InstalledSkill[];
  system: InstalledSkill[];
  catalog: CatalogSkill[];
}

// One `/name` the next prompt could start with — a skill, a custom command, a
// plugin's (`plugin:name`) or one bundled in the CLI. Offered by lib/slash.ts.
export interface SlashCommand {
  name: string;
  description: string;
  scope: "project" | "user" | "plugin" | "builtin";
}

// Plugins are the catalog's bigger sibling: Claude Code installs and versions a
// whole bundle (multi-file skills, agents, MCP servers), so `claude plugin`
// owns all of this and the bridge only relays it.
export interface Marketplace { name: string; source: string; repo?: string }
export interface InstalledPlugin {
  id: string;          // "plugin@marketplace"
  version: string;
  scope: string;       // user | project | local
  enabled: boolean;
  mcp: string[];       // MCP servers it brings — they cost context, so we show them
}
export interface AvailablePlugin {
  id: string; name: string; description: string; marketplace: string;
}
export interface PluginsInfo {
  marketplaces: Marketplace[];
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
}
export type PluginAction =
  | "market/add" | "market/remove" | "install" | "uninstall" | "update" | "enable";

async function req<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-Dash-Token"] = TOKEN;
  }
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = await res.json();
      if (d && typeof d.error === "string") msg = d.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface RunBody {
  prompt: string;
  images: string[];
  project?: string;
  session_id: string;
  model?: string;
  effort?: string;
  permission_mode?: string; // per-message operating mode; omit to use the session's
  ponytail?: string; // per-run code-minimalism intensity (off/lite/full/ultra); omit for default
  agent?: string; // who runs it: 'claude:<slot>' | 'opencode:<provider>'; omit for the ambient login
  force?: boolean; // skip the "unrelated to this session?" check (user already decided)
}

// /local/run either starts a job or holds the prompt because it looks unrelated to
// the session it would resume. Nothing is persisted when held — the prompt lives
// client-side until the user picks new-session / continue-anyway.
export type RunStarted = { job_id: string; session_id: string };
export interface RunHeld {
  suggest_new: true;
  reason: string;
  suggested_title: string | null;
}

export interface ShellSnapshot {
  status: "idle" | "running" | "done" | "error" | "killed";
  cmd: string | null;
  running: boolean;
  dir: string | null;
  code: number | null;
  lines: { seq: number; line: string }[];
  cursor: number;
}

export interface TermInfo {
  id: string;
  project: string;
  cwd_rel: string;
  cols: number;
  rows: number;
  created: number;
  alive: boolean;
  venv?: string; // project virtualenv dir this shell starts activated in, if any
}

// graphify knowledge-graph state for a project (Task 8's /local/graph/* endpoints).
export interface GraphState {
  available: boolean;
  exists: boolean;
  built_commit: string | null;
  built_at: number | null; // epoch seconds — graph.json's mtime ("last updated")
  head: string | null;
  stale: boolean;
  building: boolean;
}

// One lesson written after a turn, listed by the LEARN tab. Body is fetched
// separately — a repo can hold hundreds, and the list only needs their titles.
export interface Lesson {
  file: string; // 0007-a-slug.md, also its identity in the read endpoint
  title: string;
  concept: string; // one of learn.CONCEPTS; "" for lessons written before them
  at: number; // epoch seconds
  project?: string; // only in the ALL scope, where a lesson can be from any repo
}

// The platform's own checkout vs its upstream — powers the header sync button,
// both directions: behind/commits is theirs, ahead/dirty/files is ours.
export interface UpdateInfo {
  repo: boolean;
  path: string; // the bridge's own checkout — named in the "fix with Claude" prompt
  branch: string;
  behind: number;
  ahead: number;
  dirty: number;
  commits: { sha: string; subject: string }[];
  files: { path: string; status: string; add: number; del: number }[];
}

export const api = {
  state: () => req<DashState>("/local/state"),
  update: () => req<UpdateInfo>("/local/update"),
  applyUpdate: () =>
    req<{ ok: boolean; output: string }>("/local/update", { method: "POST", body: {} }),
  publishUpdate: () =>
    req<{ ok: boolean; output: string; message: string }>(
      "/local/update/publish", { method: "POST", body: {} }),
  restart: () => req<{ ok: boolean }>("/local/restart", { method: "POST", body: {} }),
  projects: (dir?: string) =>
    req<ProjectsListing>(`/local/projects${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  sessions: (project?: string) =>
    req<{ sessions: SessionBrief[] }>(
      `/local/sessions${project !== undefined ? `?project=${encodeURIComponent(project)}` : ""}`,
    ),
  transcript: (id: string, cursor: number, opts?: { tail?: number; before?: number }) =>
    req<Transcript>(`/local/sessions/${encodeURIComponent(id)}?cursor=${cursor}` +
      (opts?.tail ? `&tail=${opts.tail}` : "") +
      (opts?.before ? `&before=${opts.before}` : "")),
  sessionBreakdown: (id: string) =>
    req<SessionBreakdown>(`/local/sessions/${encodeURIComponent(id)}/breakdown`),
  // A rehydrated turn's attachments are server paths, not blobs — load them back
  // through the upload dir so the transcript can render (and zoom) them.
  attachmentUrl: (path: string) =>
    `/local/attachment?path=${encodeURIComponent(path)}`,
  createSession: (project: string, cwd?: string, title?: string) =>
    req<{ session: SessionBrief }>("/local/sessions", {
      method: "POST",
      body: { project, ...(cwd ? { cwd } : {}), ...(title ? { title } : {}) },
    }),
  // Copy a session's whole transcript into a new one. The copy forks its claude
  // session on first run, so continuing it never appends to the original.
  duplicateSession: (id: string) =>
    req<{ ok: boolean; session: SessionBrief }>(
      `/local/sessions/${encodeURIComponent(id)}/duplicate`, {
        method: "POST",
        body: {},
      }),
  // Move a session to another project/worktree, rewriting the old path through
  // its transcript so the model never sees the move.
  relocateSession: (id: string, project: string, branch?: string) =>
    req<{ ok: boolean; cwd: string; rewritten: number; session: SessionBrief }>(
      `/local/sessions/${encodeURIComponent(id)}/relocate`, {
        method: "POST",
        body: { project, branch },
      }),
  // Replaces the session's tags; the bridge normalizes and caps, and returns
  // what it actually kept.
  setTags: (id: string, tags: string[]) =>
    req<{ ok: boolean; tags: string[] }>(
      `/local/sessions/${encodeURIComponent(id)}/tags`, {
        method: "POST",
        body: { tags },
      }),
  // done | abandoned | backlog, or null to make it active again.
  setLifecycle: (id: string, lifecycle: Lifecycle | null) =>
    req<{ ok: boolean; lifecycle: Lifecycle | null }>(
      `/local/sessions/${encodeURIComponent(id)}/lifecycle`, {
        method: "POST",
        body: { lifecycle },
      }),
  // "No" to a question the last turn ended on: drops the session's ASK state
  // without spending a turn saying so.
  dismissAsk: (id: string) =>
    req<{ ok: boolean }>(`/local/sessions/${encodeURIComponent(id)}/dismiss-ask`, {
      method: "POST",
      body: {},
    }),
  archiveSession: (id: string) =>
    req<{ ok: boolean }>(`/local/sessions/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: {},
    }),
  setAutocompact: (id: string, autocompact: string | null) =>
    req<{ ok: boolean }>(`/local/sessions/${encodeURIComponent(id)}/autocompact`, {
      method: "POST",
      body: { autocompact },
    }),
  setPolicy: (id: string, policy: string | null) =>
    req<{ ok: boolean }>(`/local/sessions/${encodeURIComponent(id)}/policy`, {
      method: "POST",
      body: { policy },
    }),
  // The bridge health-checks every MCP server here, so the first call is slow
  // (seconds) and the rest are served from its 5-minute cache.
  toolsets: () => req<Toolsets>("/local/toolsets"),
  setToolsetDefault: (disabled_tools: string[]) =>
    req<{ ok: boolean; default: string[] }>("/local/toolsets/default", {
      method: "POST",
      body: { disabled_tools },
    }),
  inspector: () => req<InspectorState>("/local/inspector"),
  inspectorAction: (action: "on" | "off" | "clear") =>
    req<{ ok: boolean; on: boolean }>("/local/inspector", {
      method: "POST",
      body: { action },
    }),
  setSessionTools: (id: string, rules: string[]) =>
    req<{ ok: boolean; disabled_tools: string[] }>(
      `/local/sessions/${encodeURIComponent(id)}/tools`, {
        method: "POST",
        body: { disabled_tools: rules },
      }),
  // An empty objective clears the goal; the bridge owns the loop either way.
  setGoal: (id: string, objective: string) =>
    req<{ ok: boolean; goal: Goal | null }>(
      `/local/sessions/${encodeURIComponent(id)}/goal`, {
        method: "POST",
        body: { objective },
      }),
  accounts: () =>
    req<AccountsInfo>("/local/accounts"),
  accountAction: (action: "add" | "remove" | "disable" | "enable", slot?: number) =>
    req<{ ok: boolean; slot?: number }>("/local/accounts", {
      method: "POST",
      body: { action, ...(slot === undefined ? {} : { slot }) },
    }),
  /** Start a sign-in in a fresh profile — the ambient ~/.claude login is untouched. */
  loginBegin: () =>
    req<{ ok: boolean; slot: number; url: string }>("/local/accounts", {
      method: "POST",
      body: { action: "login_begin" },
    }),
  loginSubmit: (slot: number, code: string) =>
    req<{ ok: boolean; slot: number; email: string | null }>("/local/accounts", {
      method: "POST",
      body: { action: "login_submit", slot, code },
    }),
  loginCancel: (slot: number) =>
    req<{ ok: boolean }>("/local/accounts", {
      method: "POST",
      body: { action: "login_cancel", slot },
    }),
  setFreeAgent: (name: string, value: string) =>
    req<{ ok: boolean; free_agents: FreeAgents }>("/local/freeagents", {
      method: "POST",
      body: { name, value },
    }),
  /** The AI-powered extras and whether each is switched on. All ship off. */
  aiFeatures: () => req<{ features: AiFeature[] }>("/local/aifeatures"),
  setAiFeature: (key: string, enabled: boolean) =>
    req<{ ok: boolean; features: AiFeature[] }>("/local/aifeatures", {
      method: "POST",
      body: { key, enabled },
    }),
  /** Everything else that used to be reachable only by editing .env. */
  envSettings: () => req<{ settings: EnvSetting[] }>("/local/envsettings"),
  /** `value: null` clears the override, falling back to what .env said. */
  setEnvSetting: (key: string, value: string | number | boolean | null) =>
    req<{ ok: boolean; settings: EnvSetting[] }>("/local/envsettings", {
      method: "POST",
      body: { key, value },
    }),
  /** Each AI tool's own global config files (~/.claude/CLAUDE.md and friends),
   *  contents included — nothing here is more than a few KB. */
  agentConfig: () => req<{ tools: AgentConfigTool[] }>("/local/agentconfig"),
  /** Writes the file verbatim; JSON is parsed first and a parse error comes
   *  back as the request error rather than landing on disk. */
  setAgentConfig: (id: string, content: string) =>
    req<{ ok: boolean; tools: AgentConfigTool[] }>("/local/agentconfig", {
      method: "POST",
      body: { id, content },
    }),
  /** Does the bridge come up at login, and the window with it? */
  startup: () => req<StartupState>("/local/startup"),
  /** Send both switches — the server writes the whole desired state each time. */
  setStartup: (login: boolean, window: boolean) =>
    req<{ ok: boolean; startup: StartupState }>("/local/startup", {
      method: "POST",
      body: { login, window },
    }),
  /** Cached board — never spawns anything. */
  nextBoard: () => req<NextBoard>("/local/next"),
  /** Recompute in the background; poll nextBoard() until `refreshing` clears. */
  refreshNext: () =>
    req<NextBoard & { ok: boolean }>("/local/next", { method: "POST", body: {} }),
  setDefaultPolicy: (policy: string) =>
    req<{ ok: boolean; policy: string }>("/local/policy/default", {
      method: "POST",
      body: { policy },
    }),
  run: (body: RunBody) =>
    req<RunStarted | RunHeld>("/local/run", { method: "POST", body }),
  respond: (
    jobId: string,
    body: { request_id: string; behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) => req(`/local/run/${encodeURIComponent(jobId)}/respond`, { method: "POST", body }),
  interrupt: (jobId: string) =>
    req(`/local/run/${encodeURIComponent(jobId)}/interrupt`, { method: "POST", body: {} }),
  server: (action: "start" | "stop", opts: { cmd?: string } & RunCtx = {}) =>
    req<{ message: string; server: DevServerInfo; servers: DevServerInfo[] }>(
      "/local/server", { method: "POST", body: { action, ...opts } }),
  servers: () => req<{ servers: DevServerInfo[] }>("/local/servers"),
  // Path is historical — this only works out a project's run command now.
  detectRunCommand: (ctx: RunCtx) =>
    req<{ command: string; source: string; explanation: string }>(
      "/local/preview/detect", { method: "POST", body: { ...ctx } }),
  shell: (cursor: number) => req<ShellSnapshot>(`/local/shell?cursor=${cursor}`),
  shellRun: (command: string) =>
    req<{ ok: boolean; error?: string }>("/local/shell", { method: "POST", body: { command } }),
  shellKill: () => req<{ ok: boolean; error?: string }>("/local/shell/kill", { method: "POST", body: {} }),
  // --- interactive PTY terminals (multi-instance xterm.js) ---
  terminals: (project: string) =>
    req<{ terminals: TermInfo[] }>(`/local/terminals?project=${encodeURIComponent(project)}`),
  createTerminal: (project: string, cwdRel: string, cols: number, rows: number) =>
    req<{ id?: string; cwd_rel?: string; project?: string; venv?: string; error?: string }>("/local/terminals", {
      method: "POST",
      body: { project, cwd_rel: cwdRel, cols, rows },
    }),
  closeTerminal: (id: string) =>
    req<{ ok: boolean; error?: string }>(`/local/terminals/${encodeURIComponent(id)}/close`, {
      method: "POST",
      body: {},
    }),
  termWsUrl: (id: string) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/local/ws/terminal` +
    `?id=${encodeURIComponent(id)}&token=${encodeURIComponent(TOKEN)}`,
  select: (dir: string) =>
    req<{ project: Project }>("/local/select", { method: "POST", body: { dir } }),
  running: () => req<RunningInfo>("/local/running"),
  usage: () => req<UsageInfo>("/local/usage"),
  today: () => req<TodayInfo>("/local/today"),
  history: (archived = false) =>
    req<{ sessions: EnrichedSession[] }>(
      `/local/history${archived ? "?archived=1" : ""}`,
    ),
  // branch → operate on that branch's worktree (else the project checkout)
  git: (project: string, branch?: string) =>
    req<GitStatus>(
      `/local/git?project=${encodeURIComponent(project)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
  gitAll: () => req<{ repos: Record<string, GitBadge> }>("/local/git/all"),
  gitLog: (project: string, limit = 200, branch?: string) =>
    req<{ commits: GitCommit[] }>(
      `/local/git/log?project=${encodeURIComponent(project)}&limit=${limit}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
  // one commit from the graph: its changed files, or (with path) one file's diff
  gitShow: (project: string, sha: string, path?: string) =>
    req<{ ok?: boolean; files?: CompareFile[]; add?: number; del?: number; diff?: string }>(
      `/local/git/show?project=${encodeURIComponent(project)}&sha=${encodeURIComponent(sha)}${
        path ? `&path=${encodeURIComponent(path)}` : ""
      }`,
    ),
  logs: (n = 200) => req<{ lines: string[] }>(`/local/logs?n=${n}`),
  gitDiff: (project: string, path: string, base?: string, head?: string, branch?: string) =>
    req<{ path: string; diff: string }>(
      `/local/git/diff?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}${
        base && head ? `&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}` : ""
      }${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
  // paths → partial commit of only those files; branch → its worktree
  gitCommit: (project: string, message: string, paths?: string[], branch?: string) =>
    req<{ ok: boolean; output: string }>("/local/git/commit", {
      method: "POST",
      body: { project, message, ...(paths ? { paths } : {}), ...(branch ? { branch } : {}) },
    }),
  // AI-generated commit message for the selected files (one-shot headless Claude)
  commitMessage: (project: string, branch: string, paths: string[]) =>
    req<{ message?: string; error?: string }>("/local/git/commit-message", {
      method: "POST",
      body: { project, branch, paths },
    }),
  // CHANGES panel — stage / unstage / discard working-tree paths.
  gitOp: (project: string, op: "stage" | "unstage" | "discard", paths: string[], branch?: string) =>
    req<{ ok: boolean; output: string }>("/local/git/op", {
      method: "POST",
      body: { project, op, paths, ...(branch ? { branch } : {}) },
    }),
  gitPush: (project: string, branch?: string) =>
    req<{ ok: boolean; output: string }>("/local/git/push", {
      method: "POST",
      body: { project, ...(branch ? { branch } : {}) },
    }),
  // --- EDITOR tab: browse / read / write any file in the branch's working tree ---
  filesTree: (project: string, branch?: string) =>
    req<{ files: string[]; ignored?: string[] }>(
      `/local/files/tree?project=${encodeURIComponent(project)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
  fileRead: (project: string, path: string, branch?: string) =>
    req<FileContent>(
      `/local/files/read?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
  fileWrite: (project: string, path: string, content: string, branch?: string) =>
    req<{ ok: boolean; error?: string }>("/local/files/write", {
      method: "POST",
      body: { project, path, content, ...(branch ? { branch } : {}) },
    }),
  fileFormat: (project: string, path: string, content: string, branch?: string) =>
    req<{ ok: boolean; content?: string; tool?: string; error?: string }>("/local/files/format", {
      method: "POST",
      body: { project, path, content, ...(branch ? { branch } : {}) },
    }),
  // --- tags: the set every session's strip draws from ---
  tags: () => req<{ tags: TagCount[] }>("/local/tags"),
  /** Every session's prompts, newest first and deduped — what Ctrl+R searches. */
  promptHistory: () => req<{ prompts: string[] }>("/local/prompts"),
  /** Rename a tag everywhere. `next` omitted deletes it; naming an existing tag
   *  merges the two. */
  retag: (tag: string, next?: string) =>
    req<{ ok: boolean; changed: number; tags: TagCount[] }>("/local/tags", {
      method: "POST",
      body: { tag, ...(next ? { new: next } : {}) },
    }),
  /** Mint a read-only link to one session, or revoke every link it has. The
   *  page is served by the bridge itself — which binds loopback, so a link only
   *  opens elsewhere if you deliberately expose the port. */
  share: (sessionId: string, opts: { days?: number; revoke?: boolean } = {}) =>
    req<{ ok: boolean; token?: string; url?: string; expires?: number; revoked?: number }>(
      `/local/sessions/${encodeURIComponent(sessionId)}/share`,
      { method: "POST", body: opts },
    ),
  /** Rename one session, or (no title) have the model name it again. */
  retitle: (sessionId: string, title?: string) =>
    req<{ ok: boolean; generating?: boolean; session?: SessionBrief }>(
      `/local/sessions/${encodeURIComponent(sessionId)}/retitle`,
      { method: "POST", body: title ? { title } : {} },
    ),
  filesGrep: (project: string, q: string, branch?: string) =>
    req<{ hits: GrepHit[] }>(
      `/local/files/grep?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
    ),
  fileOp: (project: string, op: FileOp, path: string, to?: string, branch?: string) =>
    req<{ ok: boolean; path?: string; error?: string }>("/local/files/op", {
      method: "POST",
      body: { project, op, path, ...(to ? { to } : {}), ...(branch ? { branch } : {}) },
    }),
  projectSettings: (ctx: RunCtx) =>
    req<ProjectSettings>(`/local/project/settings?${ctxQuery(ctx)}`),
  setProjectSettings: (
    ctx: RunCtx,
    patch: { run_cmd?: string; prod_url?: string; design_project?: string; hidden?: boolean },
  ) =>
    req<{
      ok: boolean;
      run_cmd?: string | null;
      prod_url?: string | null;
      design_project?: string | null;
      hidden?: boolean;
    }>("/local/project/settings", {
      method: "POST",
      body: { ...ctx, ...patch },
    }),
  designPrompt: (ctx: RunCtx, kind: "link" | "pull" | "push", name?: string) =>
    req<{ prompt?: string; error?: string }>(
      `/local/design/prompt?kind=${kind}&${ctxQuery(ctx)}${name ? `&name=${encodeURIComponent(name)}` : ""}`),
  issues: (project: string) =>
    req<IssuesInfo>(`/local/github/issues?project=${encodeURIComponent(project)}`),
  createIssue: (project: string, title: string, body: string) =>
    req<{ ok: boolean; output: string }>("/local/github/issue", {
      method: "POST",
      body: { project, title, body },
    }),
  // --- host vitals + weather (WORKSPACE panel ambient widgets) ---
  sysinfo: () => req<HostStats>("/local/sysinfo"),
  weather: () => req<Weather>("/local/weather"),
  setWeatherCity: (city: string) =>
    req<Weather & { error?: string }>("/local/weather/city", {
      method: "POST",
      body: { city },
    }),
  setWeatherUnit: (unit: string) =>
    req<Weather & { error?: string }>("/local/weather/unit", {
      method: "POST",
      body: { unit },
    }),
  // --- branches, worktrees, PRs (unified projects view + Analyze modal) ---
  branches: (project: string) =>
    req<{ branches: string[]; current: string; default: string }>(
      `/local/git/branches?project=${encodeURIComponent(project)}`,
    ),
  worktrees: (project: string) =>
    req<{ worktrees: Worktree[] }>(
      `/local/git/worktrees?project=${encodeURIComponent(project)}`,
    ),
  compare: (project: string, base: string, head: string, dots?: 2 | 3) =>
    req<CompareInfo>(
      `/local/git/compare?project=${encodeURIComponent(project)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}${
        dots === 2 ? "&dots=2" : ""
      }`,
    ),
  // Drift between a checkpoint's commit and the tree right now (commits + uncommitted).
  since: (project: string, sha: string, branch?: string) =>
    req<{ ok: boolean; files: CompareFile[]; add: number; del: number }>(
      `/local/git/since?project=${encodeURIComponent(project)}&sha=${encodeURIComponent(sha)}${
        branch ? `&branch=${encodeURIComponent(branch)}` : ""
      }`,
    ),
  checkout: (project: string, ref: string) =>
    req<{ ok: boolean; output: string }>("/local/git/checkout", {
      method: "POST",
      body: { project, ref },
    }),
  deleteBranch: (project: string, name: string, force = false) =>
    req<{ ok: boolean; output: string }>("/local/git/branch/delete", {
      method: "POST",
      body: { project, name, force },
    }),
  merge: (project: string, branch: string, into?: string) =>
    req<{ ok: boolean; output: string }>("/local/git/merge", {
      method: "POST",
      body: { project, branch, into },
    }),
  worktreeAdd: (project: string, branch: string, parent?: string, create = true) =>
    req<{ ok: boolean; path: string; rel: string; branch: string; output: string }>(
      "/local/git/worktree",
      { method: "POST", body: { project, branch, parent, create } },
    ),
  worktreeRemove: (project: string, path: string, branch?: string, delete_branch = false) =>
    req<{ ok: boolean; output: string }>("/local/git/worktree/remove", {
      method: "POST",
      body: { project, path, branch, delete_branch },
    }),
  createPr: (project: string, head: string, base: string, title: string, body?: string) =>
    req<{ ok: boolean; url: string; number: number | null; output: string }>(
      "/local/github/pr",
      { method: "POST", body: { project, head, base, title, body } },
    ),
  createProject: (name: string, prompt: string) =>
    req<{ project: Project; session: SessionBrief; job_id: string | null }>(
      "/local/projects/create",
      { method: "POST", body: { name, prompt } },
    ),
  // --- prompt queue (per session) ---
  queue: (sessionId: string) =>
    req<QueueSnapshot>(`/local/queue?session=${encodeURIComponent(sessionId)}`),
  queueEnqueue: (body: {
    session_id: string; text: string; prompt: string; images?: string[];
    sel?: { tag: string; label: string }[]; width?: number; project?: string;
    model?: string; effort?: string; permission_mode?: string; surface?: string;
    agent?: string; // same picker as /local/run — a queued prompt keeps your agent
  }) => req<QueueSnapshot & { item_id: string }>(
    "/local/queue/enqueue", { method: "POST", body }),
  queueOp: (op: QueueOp, body: Record<string, unknown>) =>
    req<QueueSnapshot>(`/local/queue/${op}`, { method: "POST", body }),
  agents: (sessionId: string) =>
    req<AgentsInfo>(`/local/agents?session=${encodeURIComponent(sessionId)}`),
  agentActivity: (sessionId: string, agentId: string, cursor: number, workflowId?: string) =>
    req<AgentActivity>(
      `/local/agents/activity?session=${encodeURIComponent(sessionId)}` +
        `&agent=${encodeURIComponent(agentId)}&cursor=${cursor}` +
        (workflowId ? `&workflow=${encodeURIComponent(workflowId)}` : ""),
    ),
  // --- slash commands: what `/` offers in the composer (lib/slash.ts) ---
  commands: (project?: string | null) =>
    req<{ commands: SlashCommand[] }>(`/local/commands${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  // --- skills (project + system SKILL.md dirs, and the built-in catalog) ---
  skills: (project?: string | null) =>
    req<SkillsInfo>(`/local/skills${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  installSkill: (id: string, scope: SkillScope, project?: string | null) =>
    req<{ ok: boolean; error: string | null; project: InstalledSkill[]; system: InstalledSkill[] }>(
      "/local/skills/install", { method: "POST", body: { id, scope, project } }),
  // Re-installing IS the update — install overwrites what the catalog owns.
  checkSkillUpdates: (project?: string | null) =>
    req<{ outdated: { id: string; scope: SkillScope }[]; checked: number; unreachable: number }>(
      "/local/skills/check", { method: "POST", body: { project } }),
  removeSkill: (id: string, scope: SkillScope, project?: string | null) =>
    req<{ ok: boolean; error: string | null; project: InstalledSkill[]; system: InstalledSkill[] }>(
      "/local/skills/remove", { method: "POST", body: { id, scope, project } }),
  // --- plugins (marketplaces, via Claude Code's own `claude plugin`) ---
  plugins: () => req<PluginsInfo>("/local/plugins"),
  // Every mutation answers with the fresh listing, so callers never refetch.
  pluginAct: (action: PluginAction, id: string, extra?: { scope?: string; enabled?: boolean }) =>
    req<{ ok: boolean; error: string | null } & PluginsInfo>(
      `/local/plugins/${action}`, { method: "POST", body: { id, ...extra } }),
  // --- MAP tab: graphify knowledge graph (graph.html) ---
  graphState: (project: string) =>
    req<GraphState>(`/local/graph/state?project=${encodeURIComponent(project)}`),
  graphExplain: (project: string, q: string) =>
    req<{ text: string }>(
      `/local/graph/explain?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`,
    ),
  graphUpdate: (project: string) =>
    req<GraphState>("/local/graph/update", { method: "POST", body: { project } }),
  graphHtmlUrl: (project: string) =>
    `/local/graph/html?project=${encodeURIComponent(project)}`,
  // --- LEARN tab: per-turn lessons in <repo>/.mystical/learn/ ---
  lessons: (project: string) =>
    req<{ lessons: Lesson[]; repo_enabled: boolean }>(
      `/local/learn?project=${encodeURIComponent(project)}`,
    ),
  lesson: (project: string, file: string) =>
    req<{ file: string; body: string }>(
      `/local/learn?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`,
    ),
  setLessonsForRepo: (project: string, on: boolean) =>
    req<{ repo_enabled: boolean }>("/local/learn/toggle", { method: "POST", body: { project, on } }),
};

/** Query string for a run context (cwd/project/branch), omitting blanks. */
function ctxQuery(ctx: RunCtx): string {
  const p = new URLSearchParams();
  if (ctx.cwd) p.set("cwd", ctx.cwd);
  if (ctx.cwd_rel) p.set("cwd_rel", ctx.cwd_rel);
  if (ctx.project) p.set("project", ctx.project);
  if (ctx.branch) p.set("branch", ctx.branch);
  return p.toString();
}

/** Subscribe to the live dev-server log stream (SSE). Returns an unsubscribe fn. */
export function logStream(onLine: (line: string) => void): () => void {
  const es = new EventSource(`/local/stream/logs?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (typeof d.line === "string") onLine(d.line);
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}

/** Subscribe to a session's prompt queue (SSE). Each message is a full snapshot
 * (the server publishes one on every change). Returns an unsubscribe fn. */
export function queueStream(sessionId: string, onSnap: (snap: QueueSnapshot) => void): () => void {
  const es = new EventSource(
    `/local/stream/queue/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    try { onSnap(JSON.parse(e.data) as QueueSnapshot); } catch { /* ignore */ }
  };
  return () => es.close();
}

/** Subscribe to a session's run events (SSE), from `cursor`. Used by the progress
 * sidebar to render the running prompt's live tool-call stream (a turn's events
 * carry turn_id === its job_id). Returns an unsubscribe fn. */
export function sessionStream(
  sessionId: string, cursor: number, onEvent: (ev: StoreEvent) => void,
): () => void {
  const es = new EventSource(
    `/local/stream/session/${encodeURIComponent(sessionId)}?cursor=${cursor}&token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data) as StoreEvent); } catch { /* ignore */ }
  };
  return () => es.close();
}
