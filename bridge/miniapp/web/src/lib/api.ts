import { getInitData } from "./telegram";

// ---------------------------------------------------------------------------
// API types (must match the backend contract exactly).
// ---------------------------------------------------------------------------

export interface Project {
  rel: string;
  name: string;
}

export interface ServerInfo {
  status: "running" | "exited" | "not started";
  cmd: string | null;
  dir: string | null;
  pid: number | null;
}

export interface AppState {
  project: Project | null;
  busy: boolean;
  server: ServerInfo;
  permission_mode?: string; // server-side default operating mode
  models?: { id: string; label: string }[]; // live list from GET /v1/models (bridge/models.py)
  plugins?: Record<string, boolean>; // id -> installed (bridge/integrations.py); a bridge from before them sends none
}

export interface ProjectsListing {
  rel: string;
  at_base: boolean;
  can_up: boolean;
  dirs: string[];
  projects?: string[]; // git repos under BASE_PATH, org-folder nesting included
  names?: Record<string, string>; // rel -> the display name set on the dashboard
  marks?: Record<string, ProjectMark>; // rel -> its tile (bridge/projectmarks.py)
  hidden?: string[]; // rels hidden from the lists on the dashboard
}

/** What a project's tile shows and the colour it wears (bridge/projectmarks.py);
 *  the fields the phone draws of the dashboard's ProjectMark. No mark = its
 *  initials on a hashed colour. */
export interface ProjectMark {
  kind: "letters" | "icon" | "logo";
  color?: string; // "#rrggbb", or a theme ink like "var(--acc)"
  logo?: string; // "<sha256>.<ext>", fetched with api.projectLogo
}

export interface SelectResponse {
  project: Project;
}

export interface RunStartResponse {
  job_id: string;
  session_id: string;
}

// /api/run either starts a job or holds the prompt because it looks unrelated to
// the session it would resume. Nothing is persisted when held — the prompt lives
// client-side until the user picks new-session / continue-anyway.
export interface RunHeldResponse {
  suggest_new: true;
  reason: string;
  suggested_title: string | null;
}

export interface SessionBrief {
  id: string;
  title: string | null;
  project: string;
  created?: number; // epoch seconds it was started (CHATS sorts by this)
  updated: number;
  asked?: number | null; // epoch seconds its last prompt went in; null before the first (HISTORY sorts by it)
  archived: number;
  origin?: string | null; // where it started: vscode | dashboard | miniapp | bot | null
  // A Rivendell job's kind and facts (bridge/rivendell_jobs.py); null = not one.
  job?: { kind?: string; step?: string; title?: string } | null;
  fallback_policy?: string | null; // on usage limit: ask | auto | wait | null (default)
  ctx_tokens?: number | null; // window fill at the end of the last turn (null = unmeasured)
  ctx_window?: number; // what ctx_tokens is a fraction of: this session's
  // compact-at when it is a token count, else config.CONTEXT_WINDOW
  autocompact?: string | null; // compact at: "auto" | token count | null (claude's default)
  branch?: string; // the branch it is working on ("" when unknown)
  work_cwd?: string | null; // set when the shell moved into a worktree — branch came from there
  worktree?: string; // the linked worktree it runs in ("" = the project checkout)
  cwd?: string | null; // run dir — a linked worktree differs from the project dir
  // The session's effective run settings (bridge profiles.brief): a knob set
  // by hand in it, else its bound profile's, else the bridge default. Loaded
  // into the composer. Absent from a bridge older than these fields.
  model?: string | null; // null = neither it nor its profile picked one yet
  permission_mode?: string; // its own, else its profile's, else the bridge default
  effort?: string | null; // null = none set (Auto)
  profile_id?: string | null; // the profile it is bound to (bridge/profiles.py); null = none
  agent?: string; // who runs it: "claude" until agent profiles land
  account?: string; // its profile's Claude login slot; "" = the default login
  overrides?: string[]; // knobs set by hand in it, over its profile: model | permission_mode | effort
  // The Claude login it is spending now, whose usage the strip shows: the turn
  // in flight's (a fallback handover moves it off the profile's), else the one
  // its next turn takes. null = it runs on another agent. Absent from an older bridge.
  slot?: number | null;
  // Multi-agent chats (bridge _multi_brief): all absent while the EXPERIMENTAL
  // switch is off, so a client keeps its old rules. A helper is opened from its
  // transcript row, which has none of the brief's fields (lib/multi withHelperFields).
  caps?: AgentCaps;
  helpers?: HelpersConfig;
  parent_session?: string | null; // set on a helper: the chat it works under
  member?: MemberInfo | null; // a helper's facts (store.parse_member)
}

/** What this session's agent can do (bridge/agent_caps.py). The UI reads this
 *  instead of asking whether the agent is Claude. */
export interface AgentCaps {
  steer: "native" | "soft" | string;
  ask: string;
  block: boolean;
  system_prompt: boolean;
  subagents: string;
  usage: boolean;
  compact: boolean;
  tools_switch: boolean;
  goals: boolean;
  duplicate: boolean;
  skills_prefix: string;
}

/** A chat's helper limits (channel.config_for). Apply live; lowering one stops nothing. */
export interface HelpersConfig {
  helpers: "off" | "ask" | "auto";
  max_agents: number;
  max_hops: number;
  per_account: number;
  held: boolean;
}

export interface MemberInfo {
  name?: string;
  write?: boolean;
  brief?: string;
  state?: string;
  agent?: string;
  account?: string;
  started?: number;
}

export interface ExperimentalState {
  enabled: boolean;
  defaults: Partial<HelpersConfig>;
}

/** One agent under a chat (bridge/agent_tree.py): a helper Mystical started
 *  (`member`), Claude's own subagent or workflow step (`subagent`), or another
 *  provider's sub-agent we can only see exists (`opaque`, detail false). */
export interface TreeRow {
  key: string;
  kind: "member" | "subagent" | "opaque";
  name: string;
  provider: string;
  account?: string;
  model?: string | null;
  status: string;
  needs: boolean;
  detail: boolean;
  session_id?: string;
  agent_id?: string;
  workflow?: string | null;
  started?: number | null;
  updated?: number | null;
  owner?: string;
  activity?: string;
  write?: boolean;
  brief?: string;
  conflict?: boolean;
  merged?: boolean;
  has_copy?: boolean;
}

export interface ChannelMessage {
  id: string;
  chat: string;
  sender: string;
  recipient: string;
  kind: string;
  body: string;
  state: "queued" | "held" | "delivered" | "read" | "dropped" | string;
  at: number;
  meta?: Record<string, unknown>;
}

export interface ChannelView {
  config: HelpersConfig;
  messages: ChannelMessage[];
  chat: string; // the parent chat's id, also when asked for a helper
  rows: TreeRow[];
}

/** What the provider-switch dialog shows (handoff.preview). */
export interface HandoffPreview {
  needs_dialog: boolean;
  from: string;
  to: string;
  resumes: boolean;
  turns: number;
  tokens: number;
  with_tools: number;
  budget: number;
  fits: boolean;
  recent: number;
  refusal: string | null;
}

export type SwitchScope = "whole" | "recent";
export type MergeAction = "merge" | "discard" | "undo" | "review";

/** Which half of the picker a settings POST was for: the only half a running
 *  turn is switched to (the pair is saved either way; effort waits for the
 *  next turn — runner.apply_run_settings takes no live effort switch). */
export type RunPick = "model" | "permission_mode" | "effort";

/** What POST /api/session/settings saved (and switched a running turn to). */
export interface RunSettings {
  ok: boolean;
  model: string | null;
  permission_mode: string;
  effort?: string | null;
  overrides?: string[];
}

// A named, server-side bundle of agent/account/model/mode/effort/tool picks a
// session can bind to (bridge/profiles.py). Editing stays on the dashboard —
// the Mini App only lists and picks. Mirrors bridge/dashboard/web/src/lib/profiles.ts.
export interface Profile {
  id: string;
  name: string;
  agent: string;
  account: string; // a Claude login slot, as a string; "" = the default login
  model: string; // "" = not set, so the composer's pick applies
  mode: string; // permission mode; "" = not set
  effort: string; // "" = not set
  tools: string[] | null; // deny rules; null = the bridge's defaults
}

export interface ProfilesInfo {
  profiles: Profile[];
  project_defaults: Record<string, string>; // project rel -> the profile its new sessions get
}

// Mirrors bridge/dashboard/web/src/api.ts (the two clients are separate apps
// with hand-kept copies — keep them in sync).

/** Why a failed turn failed (bridge/outcomes.py) — derived server-side on every
 *  read, present only on a turn whose status is "error". */
export interface TurnOutcome {
  code: string;
  label: string;
  detail: string;
}

export interface StoreTurn {
  id: string;
  seq: number;
  prompt: string;
  attachments: string[];
  status: "running" | "done" | "error";
  outcome?: TurnOutcome | null;
  cost: number | null;
  elapsed: number | null;
  started: number;
  runtime?: string | null; // null = default Claude account; 'claude:<slot>' | 'opencode:<provider>'
  // What the turn spent. All four null = never reported (unknown, not zero).
  tok_in?: number | null;
  tok_out?: number | null;
  tok_cache_w?: number | null;
  tok_cache_r?: number | null;
}

export type StoreEvent = RunEvent & { seq: number; turn_id: string };

export interface Transcript {
  session: (SessionBrief & { claude_session_id: string | null; created: number }) | null;
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

export interface QuestionOption {
  label: string;
  description?: string;
  /** Markdown: its images are this option's pictures (lib/qpreview). */
  preview?: string;
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
  // stderr (normally nothing — a dying MCP server, or --debug), or a control
  // request it refused (src "control": a mid-turn model/mode switch).
  | { type: "log"; src: "hook" | "stderr" | "control"; label?: string; text: string; error?: boolean }
  // `agent` is Task/Agent/Skill-only (bridge/transcript_jsonl.agent_meta) and
  // absent on turns recorded before it landed.
  // `detail`: the summary's field whole, when its 120 chars cut it (transcript_jsonl.tool_detail).
  | { type: "tool"; name: string; summary: string; id?: string; detail?: string;
      agent?: { type?: string; title?: string } }
  // `output` is Bash-only, `patch` edit-only, `stat` for everything else (see
  // transcript_jsonl.tool_done); turns recorded before this landed carry no `id`.
  | {
      type: "tool_done";
      id?: string;
      ms?: number;
      output?: string;
      is_error?: boolean;
      patch?: string[];
      // How big the answer was ("512 lines", "14 tools · 32.1k tokens"), or the
      // first line of the error when the call failed.
      stat?: string;
      // Screenshots a tool returned, as upload-dir paths (see /api/attachment).
      images?: string[];
      // What a Record/Attach clip is evidence for: the model's note, the plan
      // it was recorded against, and the chapters the recorder timestamped.
      // Only on events that carry a file (runner._clip_meta).
      clip?: {
        notes?: string;
        todos?: { content: string; status: string }[];
        resolves?: number[];
        chapters?: { t: number; text: string }[];
      };
      // The pages a web tool actually reached (transcript_jsonl.web_sources).
      // Present instead of `stat` when the result was shaped as expected.
      sources?: { url: string; title?: string; code?: number }[];
    }
  // A message folded into the turn while it was already running; `images` are
  // upload-dir paths like tool_done's.
  | { type: "steer"; text: string; images?: string[] }
  | { type: "result"; result: string; cost: number; elapsed: number }
  | { type: "error"; message: string }
  | { type: "stopped" }
  | { type: "permission"; request_id: string; tool_name: string; summary: string; detail?: string }
  | { type: "question"; request_id: string; questions: Question[] }
  | { type: "permission_resolved"; request_id: string; behavior: "allow" | "deny" }
  | { type: "question_answered"; request_id: string; answers: AnswerSelection[] }
  // Multi-agent chats. A provider switch took effect on this turn (handoff.consume);
  // a helper started (channel.start); a writer's copy merged, conflicted, went back
  // out or was thrown away (channel.merge & co).
  | { type: "switch"; from: string; to: string; turns: number; whole: boolean }
  | { type: "delegation"; session_id: string; name: string; brief: string; agent: string;
      profile?: string | null; write?: boolean }
  | { type: "merge"; name: string; state: string; session_id?: string }
  // The Mystical tools (bridge/gateway_tools.py). A picture shown to you: `images` are
  // absolute paths served by /api/attachment. A recorded test run; a Markdown file
  // presented as a card, its path relative to the project; a request for a key, and
  // whether one was given (never its value). `rule`: bridge/rules.py fired.
  | { type: "figure"; kind: "shown" | "compare"; images: string[]; caption: string }
  | { type: "checks"; command: string; ok: boolean; code: number; ms: number;
      passed: number | null; failed: number | null; skipped: number | null;
      new: string[]; known: string[]; log: string; tail: string }
  | { type: "report"; path: string; title: string; summary?: string; bytes?: number }
  | { type: "secret_request"; request_id: string; name: string; why: string }
  | { type: "secret_answered"; request_id: string; given: boolean }
  | { type: "rule"; rule: string; decision: string; tool?: string; why?: string };

export type ModelId = string; // full model id from the Models API, or a short CLI alias
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionMode =
  | "auto"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk"
  | "default";

export interface PendingRequest {
  request_id: string;
  kind: "permission" | "question" | "secret";
  tool_name: string;
  summary?: string;
  questions?: Question[];
  /** A card a Mystical tool put up rather than Claude Code (bridge/gateway.py). */
  gateway?: boolean;
}

export interface RunStatus {
  status: "running" | "done" | "error";
  events: RunEvent[];
  next_cursor: number;
  pending: PendingRequest[];
  result?: string;
  cost?: number;
  elapsed?: number;
  session_id?: string;
}

/** What a secret card answers with. `answers: []` declines. */
export interface SecretAnswer {
  value: string;
}

export interface RespondBody {
  request_id: string;
  behavior?: "allow" | "deny";
  answers?: (AnswerSelection | SecretAnswer)[];
  cursor?: number;
}

// Machine-wide running sessions (external clients) + this chat's live bridge runs.
export type RunningSource = "bridge" | "vscode" | "cli" | "sdk" | string;

export interface RunningSession {
  session_id: string;
  pid: number;
  project: string;
  cwd: string;
  source: RunningSource;
  started: number | null; // epoch seconds
  status: string | null;
  waiting_for: string | null;
  state?: SessionState; // "working" while its transcript is being written, else "idle"
}

export interface AwaitingSession {
  session_id: string;
  kind: "question" | "permission";
}
// "live" = a native session touched very recently but not writing this instant
// (the backend emits it; runner._build_status). Missing it here silently dropped
// the indicator for live VS Code/terminal sessions.
// "checking" = a prompt of yours is being checked against this session before it
// runs (bridge/relevance.py); no job exists yet, but the session is in play.
// "asking" = the last turn finished by asking you something (the ASK card in the
// transcript). Nothing is blocked — but the next move is yours.
// "parked" = killed by a usage limit or API error; the bridge resumes it by itself.
// "waiting" = ended on WaitForSession; it wakes when the session it waits on
// finishes (bridge/waits.py) — its label names that session.
export type SessionState = "working" | "awaiting" | "asking" | "checking" | "parked" | "waiting" | "live" | "idle";
/** The two states where the session is stopped until you say something — one
 *  mid-turn, one at the end of it. Every "waiting" count, filter and badge
 *  means both. */
export const needsYou = (s: SessionState | string | undefined) =>
  s === "awaiting" || s === "asking";
// One unified per-session status, identical on every surface. Bridge sessions can
// be any state; native (VS Code/terminal) sessions are working/live/idle.
export interface SessionStatus {
  state: SessionState;
  kind: "question" | "permission" | null;
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
  bridge_running: string[]; // store session ids with an in-flight turn
  jobs: RunningJob[]; // this chat's live bridge runs, with activity detail
  awaiting: AwaitingSession[]; // sessions blocked on your answer/approval
  status: Record<string, SessionStatus>; // unified per-session status (working/awaiting only)
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
export type AgentsInfo = { running: number; total: number; agents: AgentInfo[];
  workflows?: { run_id: string; agents: AgentInfo[] }[] };
export type AgentActivityEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string };
export type AgentActivity = {
  // The run in the transcript's vocabulary (bridge/agents.agent_activity): text
  // and tool are what the Mini App draws; tool_done, thinking & co. ride along.
  events: (AgentActivityEvent | { type: string })[];
  next_cursor: number;
  status: "running" | "done";
  description: string;
  agent_type: string;
};

// Per-repo history: a session enriched with aggregates from its turns.
export interface EnrichedSession {
  id: string;
  title: string | null;
  project: string;
  origin?: string | null; // where it started: vscode | dashboard | miniapp | bot | null
  created: number;
  updated: number;
  archived: number;
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
  capped: number; // turns the hang watchdog killed
  turns: number;
}

// GitHub issues for the current project (via the user's authed gh CLI).
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
// One file loaded into the editor. `content` is "" for binary/too_large;
// images, PDFs, video and audio come back as a data URL in `media` with their
// `mime`. Mirrors bridge/git.py read_file.
export interface FileContent {
  ok: boolean;
  error?: string;
  path?: string;
  content?: string;
  binary?: boolean;
  too_large?: boolean;
  size?: number;
  media?: string;
  mime?: string;
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

// One session's prompt queue (bridge/queue_manager.py). Items run one at a time
// per session and auto-advance when the chat frees up.
export interface QueueItem {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  text: string;
  job_id: string | null;
  error: string | null;
  cost: number | null;
  elapsed: number | null;
  created: number;
  started: number | null;
}
// One `/name` the next prompt could start with — a skill, a custom command, a
// plugin's (`plugin:name`) or one bundled in the CLI. Offered by lib/slash.ts.
export interface SlashCommand {
  name: string;
  description: string;
  scope: "project" | "user" | "plugin" | "builtin";
}

export interface QueueSnapshot {
  session_id: string;
  seq: number;
  paused: boolean;
  items: QueueItem[];
  title?: string | null;   // set by /api/queue (the list across chats)
  project?: string | null;
}

// NEXT UP: ranked next steps across recent repos (bridge/nextup.py).
export interface NextUpItem {
  id: string;
  title: string;
  why: string;
  effort: "small" | "medium" | "large";
  evidence: string;
  repo: string;
  project: string;
  branch: string | null;
  prompt: string;
}
export interface NextUpBoard {
  items: NextUpItem[];
  generated: number | null;
  repos: string[];
  refreshing: boolean;
  enabled: boolean;
}

// The session's objective, if one is running (bridge/goals.py).
export interface Goal {
  objective: string;
  state: "active" | "complete" | "blocked";
  iter: number;
  note?: string;
}

// Claude usage — only computed percentages / reset times (no token, ever).
export interface UsageBucket {
  percent: number;
  resets_at: string | null;
  severity: string;
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
  }[];
}

// One Claude login and its meter (bridge accounts.with_meters): the rows the
// dashboard's Accounts panel lists. Read-only here.
export interface AccountInfo {
  slot: number;
  email: string | null;
  alias: string | null;
  disabled: boolean;
  default: boolean; // the ambient ~/.claude login
  left: number | null; // % of the tighter usage window unspent; null = meter unreadable
  resets_at: string | null; // when that window rolls and `left` goes back up
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  logged_in: boolean; // false = the login expired; only a re-login fixes it
  plan: string | null;
}

// ---------------------------------------------------------------------------
// Error type so the UI can distinguish auth / busy / generic failures.
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get busy(): boolean {
    return this.status === 409;
  }
}

export type ChatImagesMode = "attachment" | "inline";
/** Which chat an image address is relative to: its session, or for a chat that doesn't
 *  exist yet, the project it will start in. */
export interface ChatImageScope { session?: string | null; project?: string | null }

// ---------------------------------------------------------------------------
// Core fetch wrapper — same-origin, relative URLs, injects init data header.
// ---------------------------------------------------------------------------

const logoCache = new Map<string, Promise<string>>();

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "X-Telegram-Init-Data": getInitData(),
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Network error");
  }

  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === "object" && "error" in data) {
        const err = (data as { error: unknown }).error;
        if (typeof err === "string") message = err;
      }
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(res.status, message);
  }

  // Some endpoints could theoretically return empty bodies; all of ours
  // return JSON, so parse directly.
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Typed endpoint helpers.
// ---------------------------------------------------------------------------

export const api = {
  getState: () => request<AppState>("/api/state"),

  /** One screenshot a tool returned, as an object URL. Fetched rather than linked
   *  because an <img src> can't carry the X-Telegram-Init-Data header the API
   *  gates on; the caller revokes the URL when the image unmounts. */
  attachmentUrl: async (path: string) => {
    const res = await fetch(`/api/attachment?path=${encodeURIComponent(path)}`, {
      headers: { "X-Telegram-Init-Data": getInitData() },
    });
    if (!res.ok) throw new ApiError(res.status, "attachment gone");
    return URL.createObjectURL(await res.blob());
  },

  /** A project logo as an object URL — fetched, not linked, because an <img
   *  src> can't carry the init-data header. Its name is the bytes' hash, so
   *  one fetch per logo per launch is enough. */
  projectLogo: (name: string) => {
    let p = logoCache.get(name);
    if (!p) {
      p = fetch(`/api/project-mark/logo/${encodeURIComponent(name)}`, {
        headers: { "X-Telegram-Init-Data": getInitData() },
      }).then(async (res) => {
        if (!res.ok) throw new ApiError(res.status, "no logo");
        return URL.createObjectURL(await res.blob());
      });
      logoCache.set(name, p);
      p.catch(() => logoCache.delete(name));
    }
    return p;
  },

  getProjects: (dir?: string) => {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    return request<ProjectsListing>(`/api/projects${qs}`);
  },

  select: (dir: string) =>
    request<SelectResponse>("/api/select", { method: "POST", body: { dir } }),

  run: (
    prompt: string,
    images: string[],
    project: string | undefined,
    sessionId: string,
    model?: string,
    effort?: string,
    permission?: string,
    force?: boolean,
  ) =>
    request<RunStartResponse | RunHeldResponse>("/api/run", {
      method: "POST",
      body: { prompt, images, project, session_id: sessionId, model, effort,
              permission_mode: permission || undefined, force: force || undefined },
    }),

  getRunning: () => request<RunningInfo>("/api/running"),

  getUsage: () => request<UsageInfo>("/api/usage"),
  // Every login with its meter. A bridge older than the route answers 404.
  getAccounts: () => request<{ accounts: AccountInfo[] }>("/api/accounts"),

  getIssues: () => request<IssuesInfo>("/api/github/issues"),

  getFiles: () => request<{ files: string[] }>("/api/files"),

  readFile: (path: string) =>
    request<FileContent>(`/api/files/read?path=${encodeURIComponent(path)}`),

  writeFile: (path: string, content: string) =>
    request<{ ok: boolean; path: string }>("/api/files/write", {
      method: "POST",
      body: { path, content },
    }),

  getHistory: (archived = false) =>
    request<{ sessions: EnrichedSession[] }>(
      `/api/history${archived ? "?archived=1" : ""}`,
    ),

  /** Every session on the machine (the CHATS screen's source), with branch and
   *  worktree — /api/history has neither. */
  listAllSessions: () => request<{ sessions: SessionBrief[] }>("/api/sessions"),

  listSessions: (project: string) =>
    request<{ sessions: SessionBrief[] }>(
      `/api/sessions?project=${encodeURIComponent(project)}`,
    ),

  createSession: (project: string, title?: string, cwd?: string) =>
    request<{ session: SessionBrief }>("/api/sessions", {
      method: "POST",
      body: {
        project,
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
      },
    }),

  getSession: (id: string, cursor: number, opts?: { tail?: number; before?: number }) =>
    request<Transcript>(`/api/sessions/${encodeURIComponent(id)}?cursor=${cursor}` +
      (opts?.tail ? `&tail=${opts.tail}` : "") +
      (opts?.before ? `&before=${opts.before}` : "")),
  sessionBreakdown: (id: string) =>
    request<SessionBreakdown>(`/api/sessions/${encodeURIComponent(id)}/breakdown`),

  // "No" to a question the last turn ended on: drops the session's ASK state
  // without spending a turn saying so.
  dismissAsk: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/dismiss-ask`, {
      method: "POST",
      body: {},
    }),
  archiveSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: {},
    }),
  setPolicy: (id: string, policy: string | null) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/policy`, {
      method: "POST",
      body: { policy },
    }),
  setAutocompact: (id: string, autocompact: string | null) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/autocompact`, {
      method: "POST",
      body: { autocompact },
    }),
  // A model/mode/effort pick for a session: saved, and applied to its running
  // turn. A blank effort is Auto.
  setRunSettings: (id: string, body: { model?: string; permission_mode?: string; effort?: string; pick: RunPick }) =>
    request<RunSettings>("/api/session/settings", {
      method: "POST",
      body: { session_id: id, ...body },
    }),

  // A bridge older than profiles answers this with its catch-all 404 "not found".
  profiles: () => request<ProfilesInfo>("/api/profiles"),
  /** Bind (or "" unbind) a session's profile. A 409 means it already ran on
   *  another agent. */
  setSessionProfile: (id: string, profileId: string, scope?: SwitchScope) =>
    request<{ ok: boolean; profile_id: string | null; session: SessionBrief }>("/api/session/profile", {
      method: "POST",
      body: { session_id: id, profile_id: profileId, ...(scope ? { scope } : {}) },
    }),

  runStatus: (jobId: string, cursor: number) =>
    request<RunStatus>(
      `/api/run/${encodeURIComponent(jobId)}?cursor=${cursor}`,
    ),

  interrupt: (jobId: string, cursor: number) =>
    request<RunStatus>(`/api/run/${encodeURIComponent(jobId)}/interrupt`, {
      method: "POST",
      body: { cursor },
    }),

  respond: (jobId: string, body: RespondBody) =>
    request<RunStatus>(`/api/run/${encodeURIComponent(jobId)}/respond`, {
      method: "POST",
      body,
    }),

  getQueues: () => request<{ queues: QueueSnapshot[] }>("/api/queue"),
  // what `/` offers in the composer, for the chat's active project
  getCommands: () => request<{ commands: SlashCommand[] }>("/api/commands"),

  queueOp: (body: {
    op: "enqueue" | "remove" | "bump" | "cancel" | "retry" | "pause" | "resume" | "clear_done";
    session_id: string;
    prompt?: string;
    images?: string[];      // data URLs, saved server-side like a normal run's
    item_id?: string;
    effort?: string; // no model or mode: a queued prompt runs on the session's
  }) => request<QueueSnapshot>("/api/queue", { method: "POST", body }),

  getNextUp: () => request<NextUpBoard>("/api/nextup"),
  refreshNextUp: () =>
    request<NextUpBoard>("/api/nextup/refresh", { method: "POST", body: {} }),

  getGoal: (sessionId: string) =>
    request<{ goal: Goal | null; max_iter: number }>(
      `/api/goal?session=${encodeURIComponent(sessionId)}`,
    ),

  agents: (sessionId: string) =>
    request<AgentsInfo>(`/api/agents?session=${encodeURIComponent(sessionId)}`),
  agentActivity: (sessionId: string, agentId: string, cursor: number, workflow?: string | null) =>
    request<AgentActivity>(
      `/api/agents/activity?session=${encodeURIComponent(sessionId)}` +
        `&agent=${encodeURIComponent(agentId)}&cursor=${cursor}` +
        (workflow ? `&workflow=${encodeURIComponent(workflow)}` : ""),
    ),

  // Images in the chat (bridge/chat_images.py). Not behind the experimental switch. The
  // setting is changed on the dashboard; a bridge older than it 404s, which reads as
  // the attachments it has always had.
  chatImagesMode: () =>
    request<{ mode: ChatImagesMode }>("/api/chat-images").catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return { mode: "attachment" as const };
      throw e;
    }),
  chatImageUpload: (scope: ChatImageScope, data: string) =>
    request<{ path: string; markdown: string }>("/api/chat-images/upload", {
      method: "POST",
      body: { ...(scope.session ? { session_id: scope.session } : { project: scope.project }), data },
    }),
  /** An image in a message, as an object URL, for the same reason as attachmentUrl. The
   *  caller (lib/chatimg) keeps it and revokes it. */
  chatImageUrl: async (scope: ChatImageScope, address: string) => {
    const where = scope.session
      ? `session=${encodeURIComponent(scope.session)}`
      : `project=${encodeURIComponent(scope.project ?? "")}`;
    let res: Response;
    try {
      res = await fetch(`/api/chat-images/file?path=${encodeURIComponent(address)}&${where}`, {
        headers: { "X-Telegram-Init-Data": getInitData() },
      });
    } catch {
      throw new ApiError(0, "Network error");
    }
    if (!res.ok) throw new ApiError(res.status, "image not found");
    return URL.createObjectURL(await res.blob());
  },

  // Multi-agent chats (bridge/multi_api.py). All but the first answer 409 while the
  // switch is off; a bridge older than them 404s every one.
  experimental: () => request<ExperimentalState>("/api/experimental"),
  /** Words said in one chat, with the turn each is in (bridge/chat_search.in_chat). */
  chatSearch: (session: string, q: string) =>
    request<{ hits: { turn: string; kind: string; seq: number | null; snippet: string; at?: number }[] }>(
      `/api/chat-search?session=${encodeURIComponent(session)}&q=${encodeURIComponent(q)}`),
  /** A `report` event's Markdown file. */
  chatReport: (session: string, path: string) =>
    request<{ text: string }>(
      `/api/chat-report?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`),
  agentTrees: (ids: string[]) =>
    request<{ trees: Record<string, TreeRow[]> }>(`/api/tree?ids=${ids.map(encodeURIComponent).join(",")}`),
  channel: (sessionId: string) =>
    request<ChannelView>(`/api/channel?session=${encodeURIComponent(sessionId)}`),
  handoffPreview: (sessionId: string, profileId: string) =>
    request<HandoffPreview>(`/api/session/handoff?session=${encodeURIComponent(sessionId)}` +
      `&profile=${encodeURIComponent(profileId)}`),
  setChatConfig: (sessionId: string, config: Partial<HelpersConfig>) =>
    request<{ ok: boolean; config: HelpersConfig }>("/api/chat/config", {
      method: "POST", body: { session_id: sessionId, config },
    }),
  channelSend: (sessionId: string, to: string, text: string) =>
    request<{ ok: boolean; message: ChannelMessage }>("/api/channel/send", {
      method: "POST", body: { session_id: sessionId, to, text },
    }),
  channelHold: (sessionId: string, held: boolean) =>
    request<{ ok: boolean; config: HelpersConfig }>("/api/channel/hold", {
      method: "POST", body: { session_id: sessionId, held },
    }),
  channelEdit: (sessionId: string, id: string, edit: { body?: string; drop?: boolean }) =>
    request<{ ok: boolean }>("/api/channel/edit", {
      method: "POST", body: { session_id: sessionId, id, ...edit },
    }),
  channelStop: (sessionId: string) =>
    request<{ ok: boolean; stopped: number }>("/api/channel/stop", {
      method: "POST", body: { session_id: sessionId },
    }),
  channelMerge: (sessionId: string, name: string, action: MergeAction) =>
    request<{ ok: boolean; text: string }>("/api/channel/merge", {
      method: "POST", body: { session_id: sessionId, name, action },
    }),
  skillShare: (cwd?: string | null) =>
    request<{ skills: { key: string; name: string; on: boolean; conflict: boolean }[] }>(
      `/api/skill-share${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),

};
