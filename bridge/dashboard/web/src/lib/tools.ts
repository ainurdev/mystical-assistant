// Which card a tool event draws in the transcript, and in what accent. Pure —
// the renderer owns the markup, this only classifies the tool name.

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
  bash: "var(--acc)",
  read: "var(--purple)",
  write: "var(--ok)",
  search: "var(--warn)",
  web: "var(--info)",
  agent: "var(--acc)",
  plan: "var(--purple)",
  mcp: "var(--purple)",
  plain: "var(--acc)",
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return KIND[name] ?? "plain";
}

export function toolAccent(name: string): string {
  return ACCENT[toolKind(name)];
}

/** How loud a tool's row is, which is its consequence and not its kind:
 *  `mark` changed something on disk (or failed), `reach` left this process,
 *  `glance` only looked. A glance is the only tier that folds away — a run of
 *  reads is the noise a turn makes on its way to doing something. */
export type Tier = "mark" | "reach" | "glance";

const TIER: Record<ToolKind, Tier> = {
  write: "mark", plan: "mark",
  bash: "reach", agent: "reach", web: "reach", mcp: "reach",
  read: "glance", search: "glance",
  plain: "reach",
};

export function toolTier(name: string): Tier {
  return TIER[toolKind(name)];
}

/** The silhouette a row's tag wears. Each is the motif that kind's card used to
 *  carry as a whole box — a read has no frame because it only looked at a page,
 *  a write is filled because something on disk is different now — moved onto the
 *  tag, where it costs no height. The tag cell is one fixed width for every
 *  kind, so shape varies without the objects falling out of their column. */
export type Shape = "bare" | "fill" | "dash" | "round" | "cable" | "rail" | "box" | "term";

const SHAPE: Record<ToolKind, Shape> = {
  read: "bare",     // no frame at all — the quietest thing a row can be
  search: "dash",   // a query: nothing is committed yet
  web: "round",     // the one round thing in a square UI — the web is not this machine
  mcp: "cable",     // out of this process, into another
  agent: "rail",    // a turn nested inside your turn
  bash: "term",     // three lights: a shell ran on your machine
  plan: "box",
  write: "fill",    // dark on solid hue: the loudest a row gets
  plain: "box",
};

export function toolShape(name: string): Shape {
  return SHAPE[toolKind(name)];
}

/** `mcp__github__list_issues` → { server: "github", tool: "list issues" }. The
 *  raw name is unreadable as a tag. */
export function mcpParts(name: string): { server: string; tool: string } {
  const [, server = "", ...rest] = name.split("__");
  return { server, tool: rest.join("__").replace(/_/g, " ") };
}

/** The word a row's tag wears, which is not always the tool's own name: the tag
 *  cell holds ten characters (--axtag in index.css) and cuts short what runs
 *  past, so the names longer than that get the short one you'd say out loud.
 *  Only those are here — a label for every tool would rot the first time one
 *  is renamed, and a name that already fits is the honest thing to show. */
const TAG: Record<string, string> = {
  WebSearch: "SEARCH", WebFetch: "FETCH",  // the round shape already said "web"
  TodoWrite: "PLAN", ExitPlanMode: "PLAN", EnterPlanMode: "PLAN",
  SendMessage: "SEND", ScheduleWakeup: "WAKEUP", ReportFindings: "FINDINGS",
  NotebookEdit: "NOTEBOOK",
  "chrome-devtools": "DEVTOOLS",
};

/** An MCP server is named for a config file, not for a tag: `-mcp-server` is
 *  what every one of them is, and a plugin's `plugin_<vendor>_` prefix says the
 *  vendor twice over. Both are scaffolding around the name — with them off,
 *  `railway-mcp-server` is RAILWAY. */
const serverName = (s: string) =>
  s.replace(/^plugin_[^_]+_/, "").replace(/[-_]mcp([-_]server)?$/, "");

export function toolTag(name: string): string {
  if (toolKind(name) === "mcp") {
    const s = serverName(mcpParts(name).server);
    return (TAG[s] ?? s).toUpperCase();
  }
  return TAG[name] ?? name.toUpperCase();
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
// argument is a path, not a binary), an `echo` banner is the model labelling
// its own output — never the work — and `done`/`fi`/`esac` close a loop or a
// conditional without adding to it. The rest only shadow the next token.
const SEG_SKIP = new Set(["cd", "pushd", "popd", "export", "source", ".", "echo", "done", "fi", "esac"]);
const PREFIX = new Set(["sudo", "env", "timeout", "exec", "nohup", "setsid", "command", "time", "stdbuf"]);
// A loop or a conditional is a shell program. Its header — the list, the test —
// is syntax up to the body keyword; the body is the work, and its first command
// stands for the whole program (`for p in $(pgrep x); do ps $p; done` looks at
// processes). `elif` reopens a header; `case` and `function` never reach a body.
const HEADER = new Set(["for", "while", "until", "if", "elif", "case", "select", "function"]);
const BODY = new Set(["do", "then", "else"]);

const BIN: Record<string, CmdKind> = {
  git: "git", gh: "git", tig: "git",
  grep: "search", rg: "search", ag: "search", find: "search", fd: "search", locate: "search", which: "search",
  cat: "read", head: "read", tail: "read", less: "read", bat: "read", wc: "read", diff: "read", jq: "read",
  sed: "edit", awk: "edit", tee: "edit", patch: "edit", touch: "edit", chmod: "edit", mv: "edit", cp: "edit",
  rm: "delete", rmdir: "delete",
  ls: "fs", tree: "fs", mkdir: "fs", du: "fs", df: "fs", pwd: "fs", cd: "fs",
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

/** The leading command of a line, past the scaffolding: `cd x && git log -3`
 *  is git, with ["log", "-3"] behind it. A `cd` is not the work — but when
 *  nothing after it can be put in words (the line is only the cd, or a loop
 *  with nothing to say follows) it is the one thing left to say, so it leads.
 *  Empty otherwise.
 *  ponytail: separators are split blind, so a `|` inside quotes ends a segment
 *  early; a real shell tokenizer only if a phrase ever comes out wrong-headed. */
function lead(command: string): { bin: string; args: string[] } {
  let cd: string[] | undefined;
  let header = false; // inside a loop's list or a conditional's test, up to its body
  for (const seg of command.split(/&&|\|\||[|;\n]/)) {
    const toks = seg.trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i].replace(/^[(!{'"]+/, "");
      if (!t || t.startsWith("-") || /^\d+$/.test(t) || /^\w+=/.test(t)) continue;
      const bin = t.split("/").pop() ?? t;
      if (PREFIX.has(bin)) continue;
      if (HEADER.has(bin)) { header = true; break; }
      if (BODY.has(bin)) { header = false; continue; }
      if (header) break;
      if (bin === "cd") cd = toks.slice(i + 1);
      if (SEG_SKIP.has(bin)) break; // rest of this segment is that builtin's argument
      return { bin, args: toks.slice(i + 1) };
    }
  }
  return cd ? { bin: "cd", args: cd } : { bin: "", args: [] };
}

/** A segment that only sets the stage — a `cd`, a printed banner, the body or
 *  the close of a loop (its header counts for it, once). Not work, so it never
 *  counts toward the "+N more" the phrase owes the reader. */
const isScaffold = (seg: string) => {
  const first = (seg.trim().split(/\s+/)[0] ?? "").replace(/^[(!{'"]+/, "").split("/").pop() ?? "";
  return SEG_SKIP.has(first) || BODY.has(first);
};

export function cmdKind(command: string): CmdKind {
  // A runner invoked through its interpreter (`python3 -m pytest`, `npx vitest`)
  // is still a test run — the leading binary would say "run".
  if (/\b(pytest|vitest|jest)\b/.test(command)) return "test";
  return BIN[lead(command).bin] ?? "shell";
}

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clip = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);
const unquote = (s: string) => s.replace(/^["']|["']$/g, "").replace(/\\$/, "");

/** A command in words, so a turn reads as what it did rather than what was
 *  typed. Empty when nothing here beats showing the line itself — the row falls
 *  back to the command, which is always the honest answer. */
export function cmdAbstract(command: string): string {
  const { bin, args } = lead(command);
  if (!bin) return "";
  const rest = args.filter((a) => !a.startsWith("-") && !/^\d?[<>]/.test(a));
  const flag = (f: string) => args.includes(f);
  const [a0 = "", a1 = ""] = rest;
  // Everything after the first `&&`/`;` is real work the phrase doesn't cover —
  // except the scaffolding, which is not work anyone is owed a count of. A cd
  // that leads is scaffolding too: not among the counted, so nothing comes off.
  const more = command.split(/&&|\|\||;/).filter((s) => s.trim() && !isScaffold(s)).length - (bin === "cd" ? 0 : 1);
  const tail = more > 0 ? ` +${more} more` : "";
  const say = (s: string) => (s ? s + tail : "");

  switch (bin) {
    case "git":
      switch (a0) {
        case "add": return say(a1 === "." || flag("-A") ? "stage everything" : `stage ${plural(rest.length - 1, "file")}`);
        case "commit": return say("commit");
        case "status": return say("check the working tree");
        case "diff": return say(a1 ? `diff ${base(a1)}` : "diff the working tree");
        case "log": return say("read the last commits");
        case "show": return say(`read commit ${clip(a1 || "HEAD", 12)}`);
        case "push": return say("push");
        case "pull": case "fetch": return say(`${a0} from the remote`);
        case "branch": return say(flag("-d") || flag("-D") ? `delete branch ${rest[rest.length - 1] ?? ""}` : "list branches");
        case "checkout": case "switch": return say(`switch to ${a1}`);
        case "merge": return say(`merge ${a1}`);
        case "stash": return say("stash the working tree");
        case "worktree": return say(`${a1 || "list"} a worktree`);
        default: return say(a0 ? `git ${a0}` : "");
      }
    case "gh": return say(`gh ${[a0, a1].filter(Boolean).join(" ")}`);
    case "grep": case "rg": case "ag": {
      const where = rest.length > 2 ? plural(rest.length - 1, "file") : rest[1] ? base(rest[1]) : "the tree";
      return say(a0 ? `search \u201c${clip(unquote(a0))}\u201d in ${where}` : "");
    }
    case "find": case "fd": return say(`find files under ${base(a0) || "."}`);
    case "sed": {
      const range = rest.find((r) => /^\d+,\d+p$/.test(r));
      const file = rest.find((r) => r.includes(".") || r.includes("/"));
      if (range) return say(`read lines ${range.replace(",", "\u2013").replace("p", "")} of ${base(file ?? "")}`);
      return say(file ? `edit ${base(file)}` : "edit a file");
    }
    case "cat": case "less": case "bat":
      return say(rest.length > 1 ? `read ${plural(rest.length, "file")}` : `read ${base(a0)}`);
    case "head": case "tail": return say(a0 ? `${bin === "head" ? "read the top of" : "read the end of"} ${base(a0)}` : "");
    case "wc": return say(`count ${base(a0) || "the input"}`);
    case "ls": case "tree": return say(`list ${base(a0) || "this directory"}`);
    case "cd": {
      // Leads only when it is all the line has to say (see lead). A `$(…)` or an
      // unexpanded variable is no name for a place — the line itself is.
      const dir = base(unquote(a0)) || "~";
      return say(/^[\w.~-]+$/.test(dir) ? `enter ${dir}` : "");
    }
    case "mkdir": return say(`create ${base(a0)}`);
    case "rm": case "rmdir": return say(rest.length > 1 ? `delete ${plural(rest.length, "path")}` : `delete ${base(a0)}`);
    case "mv": return say(`move ${base(a0)}`);
    case "cp": return say(`copy ${base(a0)}`);
    case "chmod": return say(`set permissions on ${base(a1)}`);
    case "python": case "python3":
      if (/\bpytest\b/.test(command)) return say("run the tests");
      if (args[0] === "-c") return say("run a python one-liner");
      if (a0 === "-" || /<<'?\w+'?/.test(command)) return say("run a python snippet");
      if (args[0] === "-m") return say(`run the ${a0} module`);
      return say(a0 ? `run ${base(a0)}` : "python");
    case "node": case "deno": case "bun": return say(a0 ? `run ${base(a0)}` : bin);
    case "npm": case "pnpm": case "yarn":
      if (a0 === "run") return say(`run the ${a1} script`);
      if (a0 === "install" || a0 === "i") return say("install packages");
      return say(`${bin} ${a0}`);
    case "npx": return say(`run ${a0}`);
    case "vite": return say(a0 === "build" ? "build the app" : `vite ${a0}`);
    case "tsc": return say("typecheck");
    case "pytest": return say("run the tests");
    case "curl": case "wget": {
      const url = rest.find((r) => r.startsWith("http")) ?? "";
      try { return say(`fetch ${new URL(url).host}`); } catch { return say("fetch a url"); }
    }
    case "ssh": return say(`ssh ${a0}`);
    case "docker": case "podman": case "kubectl": return say(`${bin} ${a0}`);
    case "systemctl": case "journalctl": {
      const verb = rest.find((r) => ["start", "stop", "restart", "status", "enable", "disable"].includes(r));
      const unit = rest.find((r) => r.includes(".") || r.includes("-"));
      return say(verb ? `${verb} ${base(unit ?? "")}`.trim() : bin);
    }
    case "pkill": case "pgrep": case "kill": return say(`${bin === "kill" ? "kill" : bin === "pkill" ? "kill" : "find"} ${clip(a0 || "a process", 20)}`);
    case "ps": case "top": case "htop": return say("look at running processes");
    default:
      // A subcommand is the one generic phrase worth making: `mystical status`
      // says more than the flags after it. Anything else keeps its own line.
      return a0 && /^[a-z][\w-]*$/.test(a0) ? say(`${bin} ${a0}`) : "";
  }
}
