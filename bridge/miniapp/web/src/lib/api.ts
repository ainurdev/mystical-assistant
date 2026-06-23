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
  | { type: "question_answered"; request_id: string; answers: AnswerSelection[] };

export type ModelId = "opus" | "sonnet" | "haiku";
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
}

export interface RunningInfo {
  external: RunningSession[];
  bridge_running: string[]; // store session ids with an in-flight turn
}

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
  ) =>
    request<RunStartResponse>("/api/run", {
      method: "POST",
      body: { prompt, images, project, session_id: sessionId, model, effort },
    }),

  getRunning: () => request<RunningInfo>("/api/running"),

  getUsage: () => request<UsageInfo>("/api/usage"),

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

  preview: (action: "start" | "stop", port?: number) =>
    request<PreviewActionResponse>("/api/preview", {
      method: "POST",
      body: { action, port },
    }),
};
