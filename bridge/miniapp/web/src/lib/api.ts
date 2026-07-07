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
}

export interface SelectResponse {
  project: Project;
}

export interface RunStartResponse {
  job_id: string;
  session_id: string;
}

export interface SessionBrief {
  id: string;
  title: string | null;
  project: string;
  updated: number;
  archived: number;
  origin?: string | null; // where it started: vscode | dashboard | miniapp | bot | null
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
  | { type: "question_answered"; request_id: string; answers: AnswerSelection[] }
  | {
      type: "memory_candidate";
      item_id: string;
      mem_type: string;
      scope: string;
      title: string;
      body: string;
    }
  | { type: "review_candidate"; item_id: string; title: string; why_it_matters: string; snippet: string }
  | { type: "review_resolved"; item_id: string; action: "kept" | "skipped" };

export type LearningItem = {
  id: string;
  project_path: string;
  title: string;
  code_snippet: string;
  why_it_matters: string;
  status: string;
  mastery: number;
  times_reviewed: number;
  notes: string;
};

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

export interface ServerActionResponse {
  server: ServerInfo;
}

export interface LogsResponse {
  lines: string[];
}

export interface PreviewActionResponse {
  preview: PreviewInfo;
  message: string;
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

// Per-project run settings: package.json scripts + the persisted run command.
export interface ProjectSettings {
  scripts: Record<string, string>;
  run_cmd: string | null;
  default_cmd: string;
  log_path: string;
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

// Project memory: a curated fact injected into turns for its project/branch.
export interface Memory {
  id: string;
  owner_id: number;
  scope: "user" | "project";
  project_path: string | null;
  branch: string | null;
  type: string;
  title: string;
  body: string;
  status: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

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
  ) =>
    request<RunStartResponse>("/api/run", {
      method: "POST",
      body: { prompt, images, project, session_id: sessionId, model, effort,
              permission_mode: permission || undefined },
    }),

  getRunning: () => request<RunningInfo>("/api/running"),

  getUsage: () => request<UsageInfo>("/api/usage"),

  getIssues: () => request<IssuesInfo>("/api/github/issues"),

  getProjectSettings: () => request<ProjectSettings>("/api/project/settings"),

  setProjectSettings: (run_cmd: string) =>
    request<{ ok: boolean; run_cmd: string | null }>("/api/project/settings", {
      method: "POST",
      body: { run_cmd },
    }),

  getHistory: (archived = false) =>
    request<{ sessions: EnrichedSession[] }>(
      `/api/history${archived ? "?archived=1" : ""}`,
    ),

  listSessions: (project: string) =>
    request<{ sessions: SessionBrief[] }>(
      `/api/sessions?project=${encodeURIComponent(project)}`,
    ),

  createSession: (project: string) =>
    request<{ session: SessionBrief }>("/api/sessions", {
      method: "POST",
      body: { project },
    }),

  getSession: (id: string, cursor: number) =>
    request<Transcript>(`/api/sessions/${encodeURIComponent(id)}?cursor=${cursor}`),

  archiveSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: {},
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

  server: (action: "start" | "stop", cmd?: string) =>
    request<ServerActionResponse>("/api/server", {
      method: "POST",
      body: { action, cmd },
    }),

  logs: (n: number) => request<LogsResponse>(`/api/logs?n=${n}`),

  getShell: (cursor: number) => request<ShellSnapshot>(`/api/shell?cursor=${cursor}`),
  runShell: (command: string) =>
    request<{ ok: boolean; error?: string }>("/api/shell", {
      method: "POST",
      body: { command },
    }),
  killShell: () =>
    request<{ ok: boolean; error?: string }>("/api/shell/kill", {
      method: "POST",
      body: {},
    }),

  preview: (action: "start" | "stop", port?: number) =>
    request<PreviewActionResponse>("/api/preview", {
      method: "POST",
      body: { action, port },
    }),

  screenshot: (width: number) =>
    request<{ data_url: string }>("/api/preview/screenshot", { method: "POST", body: { width } }),

  agents: (sessionId: string) =>
    request<AgentsInfo>(`/api/agents?session=${encodeURIComponent(sessionId)}`),
  agentActivity: (sessionId: string, agentId: string, cursor: number) =>
    request<AgentActivity>(
      `/api/agents/activity?session=${encodeURIComponent(sessionId)}` +
        `&agent=${encodeURIComponent(agentId)}&cursor=${cursor}`,
    ),

  memoryItems: (project?: string, status = "active") =>
    request<{ items: Memory[] }>(
      `/api/memory/items?status=${encodeURIComponent(status)}` +
        (project ? `&project=${encodeURIComponent(project)}` : ""),
    ),
  memoryCandidate: (itemId: string, action: "keep" | "skip") =>
    request<{ item: Memory | null }>("/api/memory/candidate", {
      method: "POST",
      body: { item_id: itemId, action },
    }),
  memoryUpdate: (itemId: string, title?: string, body?: string) =>
    request<{ item: Memory }>("/api/memory/update", {
      method: "POST",
      body: { item_id: itemId, title, body },
    }),
  memoryStatus: (itemId: string, status: "active" | "archived") =>
    request<{ item: Memory }>("/api/memory/status", {
      method: "POST",
      body: { item_id: itemId, status },
    }),
  memoryPin: (itemId: string, pinned: boolean) =>
    request<{ item: Memory }>("/api/memory/pin", {
      method: "POST",
      body: { item_id: itemId, pinned },
    }),
  learningItems: (project?: string) =>
    request<{ items: LearningItem[] }>(
      `/api/learning/items${project ? `?project=${encodeURIComponent(project)}` : ""}`,
    ),

  learningItem: (itemId: string, action: "keep" | "skip" | "archive" | "reviewed") =>
    request<{ ok: true }>("/api/learning/item", {
      method: "POST",
      body: { item_id: itemId, action },
    }),

  learningTeach: (body: {
    item_id: string;
    mode: "explain" | "quiz" | "exercise" | "grade";
    user_answer?: string;
  }) => request<{ text: string }>("/api/learning/teach", { method: "POST", body }),
};

export interface ShellSnapshot {
  status: "idle" | "running" | "done" | "error" | "killed";
  cmd: string | null;
  running: boolean;
  dir: string | null;
  code: number | null;
  lines: { seq: number; line: string }[];
  cursor: number;
}
