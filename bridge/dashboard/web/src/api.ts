// The dashboard server hands out a per-process token in the URL the user opens
// (http://127.0.0.1:8790/?token=...). We keep it and send it on every
// state-changing request (X-Dash-Token) and on SSE streams (?token=). Cross-origin
// pages can't read it, which (with the server's Host allow-list) is the CSRF defense.
const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") ?? "";

export interface Project {
  rel: string;
  name: string;
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

export type StoreEvent = RunEvent & { seq: number; turn_id: string };

export interface Transcript {
  session: SessionBrief | null;
  turns: StoreTurn[];
  events: StoreEvent[];
  next_cursor: number;
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
export interface DashState {
  project: Project | null;
  busy: boolean;
  busy_chat: number | null;
  server: ServerInfo;
  preview: PreviewInfo;
  permission_mode?: string | null;
}
export interface ProjectsListing {
  rel: string;
  at_base: boolean;
  can_up: boolean;
  dirs: string[];
}

export interface GitFile {
  path: string;
  status: string;
  add: number;
  del: number;
}
export interface GitStatus {
  is_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  files: GitFile[];
}
export interface GitBadge {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
}

export interface GitHubLabel {
  name: string;
  color: string;
}
export interface Issue {
  number: number;
  title: string;
  url: string;
  updated: string;
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

export type ModelId = "opus" | "sonnet" | "haiku";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

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
}
export interface AwaitingSession {
  session_id: string;
  kind: "question" | "permission";
}
export interface RunningInfo {
  external: RunningSession[];
  bridge_running: string[];
  awaiting: AwaitingSession[]; // sessions blocked on your answer/approval
}
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
}

export const api = {
  state: () => req<DashState>("/local/state"),
  projects: (dir?: string) =>
    req<ProjectsListing>(`/local/projects${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  sessions: (project?: string) =>
    req<{ sessions: SessionBrief[] }>(
      `/local/sessions${project !== undefined ? `?project=${encodeURIComponent(project)}` : ""}`,
    ),
  transcript: (id: string, cursor: number) =>
    req<Transcript>(`/local/sessions/${encodeURIComponent(id)}?cursor=${cursor}`),
  createSession: (project: string) =>
    req<{ session: SessionBrief }>("/local/sessions", { method: "POST", body: { project } }),
  run: (body: RunBody) =>
    req<{ job_id: string; session_id: string }>("/local/run", { method: "POST", body }),
  respond: (
    jobId: string,
    body: { request_id: string; behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) => req(`/local/run/${encodeURIComponent(jobId)}/respond`, { method: "POST", body }),
  interrupt: (jobId: string) =>
    req(`/local/run/${encodeURIComponent(jobId)}/interrupt`, { method: "POST", body: {} }),
  server: (action: "start" | "stop", cmd?: string) =>
    req<{ message: string }>("/local/server", { method: "POST", body: { action, cmd } }),
  preview: (action: "start" | "stop", port?: number) =>
    req<{ message: string }>("/local/preview", { method: "POST", body: { action, port } }),
  select: (dir: string) =>
    req<{ project: Project }>("/local/select", { method: "POST", body: { dir } }),
  running: () => req<RunningInfo>("/local/running"),
  usage: () => req<UsageInfo>("/local/usage"),
  history: (archived = false) =>
    req<{ sessions: EnrichedSession[] }>(
      `/local/history${archived ? "?archived=1" : ""}`,
    ),
  git: (project: string) =>
    req<GitStatus>(`/local/git?project=${encodeURIComponent(project)}`),
  gitAll: () => req<{ repos: Record<string, GitBadge> }>("/local/git/all"),
  gitDiff: (project: string, path: string) =>
    req<{ path: string; diff: string }>(
      `/local/git/diff?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
    ),
  gitCommit: (project: string, message: string) =>
    req<{ ok: boolean; output: string }>("/local/git/commit", {
      method: "POST",
      body: { project, message },
    }),
  gitPush: (project: string) =>
    req<{ ok: boolean; output: string }>("/local/git/push", {
      method: "POST",
      body: { project },
    }),
  issues: (project: string) =>
    req<IssuesInfo>(`/local/github/issues?project=${encodeURIComponent(project)}`),
  createIssue: (project: string, title: string, body: string) =>
    req<{ ok: boolean; output: string }>("/local/github/issue", {
      method: "POST",
      body: { project, title, body },
    }),
};

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
