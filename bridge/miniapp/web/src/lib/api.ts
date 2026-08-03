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

export interface PreviewInfo {
  url: string | null;
  port: number | null;
}

export interface AppState {
  project: Project | null;
  busy: boolean;
  server: ServerInfo;
  preview: PreviewInfo;
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
}

export type StoreEvent = RunEvent & { seq: number; turn_id: string };

export interface Transcript {
  session: (SessionBrief & { claude_session_id: string | null; created: number }) | null;
  turns: StoreTurn[];
  events: StoreEvent[];
  next_cursor: number;
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
  | { type: "tool"; name: string; summary: string }
  | { type: "tool_done" }
  | { type: "result"; result: string; cost: number; elapsed: number }
  | { type: "error"; message: string }
  | { type: "stopped" }
  | { type: "permission"; request_id: string; tool_name: string; summary: string }
  | { type: "question"; request_id: string; questions: Question[] }
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
export type SessionState = "working" | "awaiting" | "live" | "idle";
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
  total_cost: number;
  last_activity: number;
  models: string[];
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
export interface IssuesInfo {
  has_remote: boolean;
  slug: string | null;
  gh_ok: boolean;
  error: string;
  open_count: number;
  closed_count: number;
  issues: Issue[];
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

  getHistory: (archived = false) =>
    request<{ sessions: EnrichedSession[] }>(
      `/api/history${archived ? "?archived=1" : ""}`,
    ),

  listSessions: (project: string) =>
    request<{ sessions: SessionBrief[] }>(
      `/api/sessions?project=${encodeURIComponent(project)}`,
    ),

  createSession: (project: string, title?: string) =>
    request<{ session: SessionBrief }>("/api/sessions", {
      method: "POST",
      body: { project, ...(title ? { title } : {}) },
    }),

  getSession: (id: string, cursor: number) =>
    request<Transcript>(`/api/sessions/${encodeURIComponent(id)}?cursor=${cursor}`),

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

  agents: (sessionId: string) =>
    request<AgentsInfo>(`/api/agents?session=${encodeURIComponent(sessionId)}`),
  agentActivity: (sessionId: string, agentId: string, cursor: number) =>
    request<AgentActivity>(
      `/api/agents/activity?session=${encodeURIComponent(sessionId)}` +
        `&agent=${encodeURIComponent(agentId)}&cursor=${cursor}`,
    ),

};
