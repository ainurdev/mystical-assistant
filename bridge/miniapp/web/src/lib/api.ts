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
}

export type RunEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "tool_done" }
  | { type: "result"; result: string; cost: number; elapsed: number }
  | { type: "error"; message: string };

export interface RunStatus {
  status: "running" | "done" | "error";
  events: RunEvent[];
  next_cursor: number;
  result?: string;
  cost?: number;
  elapsed?: number;
  session_id?: string;
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

  run: (prompt: string, images: string[], project?: string) =>
    request<RunStartResponse>("/api/run", {
      method: "POST",
      body: { prompt, images, project },
    }),

  runStatus: (jobId: string, cursor: number) =>
    request<RunStatus>(
      `/api/run/${encodeURIComponent(jobId)}?cursor=${cursor}`,
    ),

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
