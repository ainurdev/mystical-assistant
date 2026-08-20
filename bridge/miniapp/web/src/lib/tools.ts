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

/** What a Bash command is *doing*, for the icon on its row — a `git` line reads
 *  as git before you read it. One kind per row: the first real binary wins, so
 *  `grep -n x f | head` is a search, not a read. */
export type CmdKind =
  | "git" | "search" | "read" | "edit" | "delete" | "fs" | "run"
  | "pkg" | "test" | "net" | "proc" | "db" | "docker" | "shell";

// Scaffolding in front of the real command. `cd` owns its whole segment (its
// argument is a path, not a binary); the rest only shadow the next token.
const SEG_SKIP = new Set(["cd", "pushd", "popd", "export", "source", "."]);
const PREFIX = new Set(["sudo", "env", "timeout", "exec", "nohup", "setsid", "command", "time", "stdbuf"]);

const BIN: Record<string, CmdKind> = {
  git: "git", gh: "git", tig: "git",
  grep: "search", rg: "search", ag: "search", find: "search", fd: "search", locate: "search", which: "search",
  cat: "read", head: "read", tail: "read", less: "read", bat: "read", wc: "read", diff: "read", jq: "read",
  sed: "edit", awk: "edit", tee: "edit", patch: "edit", touch: "edit", chmod: "edit", mv: "edit", cp: "edit",
  rm: "delete", rmdir: "delete",
  ls: "fs", tree: "fs", mkdir: "fs", du: "fs", df: "fs", pwd: "fs",
  python: "run", python3: "run", node: "run", deno: "run", bun: "run", ruby: "run", perl: "run", go: "run",
  bash: "run", sh: "run", zsh: "run",
  npm: "pkg", npx: "pkg", pnpm: "pkg", yarn: "pkg", pip: "pkg", pip3: "pkg", uv: "pkg", cargo: "pkg",
  make: "pkg", tsc: "pkg", vite: "pkg", brew: "pkg", apt: "pkg",
  pytest: "test", vitest: "test", jest: "test", playwright: "test",
  curl: "net", wget: "net", ssh: "net", scp: "net", ping: "net", nc: "net", rsync: "net",
  ps: "proc", pkill: "proc", pgrep: "proc", kill: "proc", top: "proc", htop: "proc",
  systemctl: "proc", journalctl: "proc",
  docker: "docker", podman: "docker", kubectl: "docker",
  psql: "db", sqlite3: "db", mysql: "db", "redis-cli": "db",
};

export function cmdKind(command: string): CmdKind {
  // A runner invoked through its interpreter (`python3 -m pytest`, `npx vitest`)
  // is still a test run — the leading binary would say "run".
  if (/\b(pytest|vitest|jest)\b/.test(command)) return "test";
  for (const seg of command.split(/&&|\|\||[|;\n]/)) {
    for (const tok of seg.trim().split(/\s+/)) {
      const t = tok.replace(/^[(!{'"]+/, "");
      if (!t || t.startsWith("-") || /^\d+$/.test(t) || /^\w+=/.test(t)) continue;
      const bin = t.split("/").pop() ?? t;
      if (PREFIX.has(bin)) continue;
      if (SEG_SKIP.has(bin)) break; // rest of this segment is that builtin's argument
      return BIN[bin] ?? "shell";
    }
  }
  return "shell";
}
