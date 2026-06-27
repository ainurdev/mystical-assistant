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
  cwd?: string | null; // run dir — a linked worktree differs from the project dir
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
  default_cmd: string;
  log_path: string;
}

export type ModelId = "opus" | "sonnet" | "haiku";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

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
// active (alive but briefly paused); awaiting = blocked on you; else idle.
export type SessionState = "working" | "awaiting" | "live" | "idle";
// One unified per-session status, identical on every surface. Bridge sessions can
// be any state; native (VS Code/terminal) sessions are working/idle only.
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
  permission_mode?: string; // per-message operating mode; omit to use the session's
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
  createSession: (project: string, cwd?: string) =>
    req<{ session: SessionBrief }>("/local/sessions", {
      method: "POST",
      body: cwd ? { project, cwd } : { project },
    }),
  archiveSession: (id: string) =>
    req<{ ok: boolean }>(`/local/sessions/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: {},
    }),
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
  shell: (cursor: number) => req<ShellSnapshot>(`/local/shell?cursor=${cursor}`),
  shellRun: (command: string) =>
    req<{ ok: boolean; error?: string }>("/local/shell", { method: "POST", body: { command } }),
  shellKill: () => req<{ ok: boolean; error?: string }>("/local/shell/kill", { method: "POST", body: {} }),
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
  logs: (n = 200) => req<{ lines: string[] }>(`/local/logs?n=${n}`),
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
  projectSettings: (project: string) =>
    req<ProjectSettings>(`/local/project/settings?project=${encodeURIComponent(project)}`),
  setProjectSettings: (project: string, run_cmd: string) =>
    req<{ ok: boolean; run_cmd: string | null }>("/local/project/settings", {
      method: "POST",
      body: { project, run_cmd },
    }),
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
  // --- branches, worktrees, PRs (unified projects view + Analyze modal) ---
  branches: (project: string) =>
    req<{ branches: string[]; current: string }>(
      `/local/git/branches?project=${encodeURIComponent(project)}`,
    ),
  worktrees: (project: string) =>
    req<{ worktrees: Worktree[] }>(
      `/local/git/worktrees?project=${encodeURIComponent(project)}`,
    ),
  compare: (project: string, base: string, head: string) =>
    req<CompareInfo>(
      `/local/git/compare?project=${encodeURIComponent(project)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
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
  screenshot: (width: number) =>
    req<{ data_url: string }>("/local/preview/screenshot", { method: "POST", body: { width } }),
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
