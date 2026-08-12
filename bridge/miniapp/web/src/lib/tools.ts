// Which card a tool event draws in the transcript, and in what accent. Pure —
// the renderer owns the markup, this only classifies the tool name.
//
// The dashboard carries its own copy (bridge/dashboard/web/src/lib/tools.ts):
// same classification, different accent tokens, because the two apps are
// separate Vite builds with no shared package. lib/toolfold.ts and
// lib/askback.ts are duplicated the same way.

export type ToolKind =
  | "bash" | "read" | "write" | "search" | "web" | "agent" | "plan" | "mcp" | "plain";

const KIND: Record<string, ToolKind> = {
  Bash: "bash", BashOutput: "bash", KillShell: "bash",
  Read: "read", NotebookRead: "read",
  Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
  Grep: "search", Glob: "search", LS: "search", ToolSearch: "search",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent", Skill: "agent",
  TodoWrite: "plan", ExitPlanMode: "plan", EnterPlanMode: "plan",
};

// Six hues for nine kinds — cards that share one always differ in shape (a
// terminal window is never mistaken for a one-line chip).
const ACCENT: Record<ToolKind, string> = {
  bash: "var(--brand-soft)",
  read: "var(--violet)",
  write: "var(--success)",
  search: "var(--warning)",
  web: "var(--info)",
  agent: "var(--brand-soft)",
  plan: "var(--violet)",
  mcp: "var(--violet)",
  plain: "var(--brand-soft)",
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return KIND[name] ?? "plain";
}

export function toolAccent(name: string): string {
  return ACCENT[toolKind(name)];
}

/** `mcp__github__list_issues` → { server: "github", tool: "list issues" }. The
 *  raw name is unreadable as a tag. */
export function mcpParts(name: string): { server: string; tool: string } {
  const [, server = "", ...rest] = name.split("__");
  return { server, tool: rest.join("__").replace(/_/g, " ") };
}

/** The host of a URL, so a fetch reads as the site it hit and the rest of the
 *  URL can be dimmed. Empty for a search query (WebSearch) — not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
