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
}

export interface ProjectsListing {
  rel: string;
  at_base: boolean;
  can_up: boolean;
  dirs: string[];
  projects?: string[]; // git repos under BASE_PATH, org-folder nesting included
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
  updated: number;
  archived: number;
  origin?: string | null; // where it started: vscode | dashboard | miniapp | bot | null
  fallback_policy?: string | null; // on usage limit: ask | auto | wait | null (default)
  ctx_tokens?: number | null; // window fill at the end of the last turn (null = unmeasured)
  ctx_window?: number; // what ctx_tokens is a fraction of (config.CONTEXT_WINDOW)
  autocompact?: string | null; // compact at: "auto" | token count | null (claude's default)
  branch?: string; // the branch it is working on ("" when unknown)
  work_cwd?: string | null; // set when the shell moved into a worktree — branch came from there
  worktree?: string; // the linked worktree it runs in ("" = the project checkout)
  cwd?: string | null; // run dir — a linked worktree differs from the project dir
  stype?: string | null; // the flow this session runs (null = a plain chat)
  stage?: string | null; // where in that flow it is ("done" = finished)
}

// Mirrors bridge/dashboard/web/src/api.ts (the two clients are separate apps
// with hand-kept copies — keep them in sync).
export interface HudCardAction {
  label: string;
  send: string;
}
export interface HudCard {
  stage: string;
  summary: string;
  fields: Record<string, unknown>;
  advance?: boolean; // the model asking to move on — gated stages still wait for you
  actions?: HudCardAction[];
}
export interface FlowField {
  key: string;
  label: string;
  required?: boolean;
  multiline?: boolean;
}
// A field's type is a rendering contract the flow declares (bridge/flow.py
// _SHAPES): the card draws the matching widget, or falls back to text when the
// model emitted something else.
export interface FlowFieldShape {
  name: string;
  type: string;
}
export interface FlowStageShape {
  id: string;
  label: string;
  gate: boolean;
  fields: FlowFieldShape[];
  /** How this stage wants to be engaged: approve | arm | evidence | triage |
   *  annotate. "" for a stage that only wants a message. */
  input: string;
  /** Flows a card on this stage can open as a fresh session. */
  handoff: string[];
}
export interface FlowShape {
  stype: string;
  label: string;
  blurb: string;
  source: "builtin" | "custom";
  form: FlowField[];
  stages: FlowStageShape[];
}
export interface FlowCatalog {
  enabled: boolean;
  auto: boolean; // AUTO TYPE switch: every prompt classifies, pickers hide
  flows: FlowShape[];
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
  // `agent` is Task/Agent/Skill-only (bridge/transcript_jsonl.agent_meta) and
  // absent on turns recorded before it landed.
  | { type: "tool"; name: string; summary: string; id?: string;
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
    }
  // A message folded into the turn while it was already running; `images` are
  // upload-dir paths like tool_done's.
  | { type: "steer"; text: string; images?: string[] }
  | { type: "result"; result: string; cost: number; elapsed: number }
  | { type: "error"; message: string }
  | { type: "stopped" }
  | { type: "permission"; request_id: string; tool_name: string; summary: string }
  | { type: "question"; request_id: string; questions: Question[] }
  // A typed session's settled turn: the parsed hud-card (the raw fence is
  // stripped from the text above it) and every move between stages.
  // stype: the flow the card was written under — absent on cards from before
  // sessions re-typed per prompt, which render against the session's flow.
  | { type: "card"; card: HudCard; stage: string; stype?: string; gated?: boolean }
  | { type: "stage"; from: string | null; to: string; by: "auto" | "user" }
  | { type: "retype"; from: string | null; to: string | null;
      stage: string | null; by: "auto" | "user" }
  | { type: "card_missing"; errors?: string[] }
  | { type: "permission_resolved"; request_id: string; behavior: "allow" | "deny" }
  | { type: "question_answered"; request_id: string; answers: AnswerSelection[] };

export type ModelId = string; // full model id from the Models API, or a short CLI alias
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionMode =
  | "auto"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "default";

export interface PendingRequest {
  request_id: string;
  kind: "permission" | "question";
  tool_name: string;
  summary?: string;
  questions?: Question[];
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

export interface RespondBody {
  request_id: string;
  behavior?: "allow" | "deny";
  answers?: AnswerSelection[];
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
export type SessionState = "working" | "awaiting" | "asking" | "checking" | "live" | "idle";
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
export type AgentsInfo = { running: number; total: number; agents: AgentInfo[] };
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
  stype?: string | null; // the flow this session runs (null = a plain chat)
  stage?: string | null;
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

// ---------------------------------------------------------------------------
// Core fetch wrapper — same-origin, relative URLs, injects init data header.
// ---------------------------------------------------------------------------

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

  listSessions: (project: string) =>
    request<{ sessions: SessionBrief[] }>(
      `/api/sessions?project=${encodeURIComponent(project)}`,
    ),

  createSession: (project: string, title?: string, cwd?: string, stype?: string) =>
    request<{ session: SessionBrief }>("/api/sessions", {
      method: "POST",
      body: {
        project,
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
        ...(stype ? { stype } : {}),
      },
    }),

  flows: () => request<FlowCatalog>("/api/flows"),
  // AUTO TYPE reads one message and can be wrong; null clears back to chat.
  retypeSession: (sid: string, stype: string | null) =>
    request<{ ok: boolean; stype: string | null; stage: string | null }>(
      `/api/sessions/${encodeURIComponent(sid)}/stype`,
      { method: "POST", body: { stype } }),

  // The move is the server's to make — this asks for it.
  setStage: (sid: string, action: "advance" | "back" | "set", stage?: string) =>
    request<{ ok: boolean; stage: string }>(
      `/api/sessions/${encodeURIComponent(sid)}/stage`,
      { method: "POST", body: { action, ...(stage ? { stage } : {}) } },
    ),

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
    model?: string;
    effort?: string;
    permission_mode?: string;
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
  agentActivity: (sessionId: string, agentId: string, cursor: number) =>
    request<AgentActivity>(
      `/api/agents/activity?session=${encodeURIComponent(sessionId)}` +
        `&agent=${encodeURIComponent(agentId)}&cursor=${cursor}`,
    ),

};
