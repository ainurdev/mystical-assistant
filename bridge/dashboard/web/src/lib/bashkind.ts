// What a shell command was for. "Bash" is most of a turn's calls, so "41 commands"
// says nothing: a WORK header that says 3 tests, 2 builds, 30 reads does. Pure, and
// a guess by design: it reads the words, never runs anything, and what it can't name
// is "other", which is the honest answer rather than a failure.
//
// A chain is judged by its most consequential part: `cd web && npm test | tail -5` is
// tests, not a directory change. Why a priority and not the first or last word: the
// head of a chain is usually set-up and its tail usually a pipe trimming the output.

export type BashKind = "tests" | "build" | "git" | "search" | "read" | "install" | "run" | "other";

/** The order the header lists them in, and the order a chain is judged by: what
 *  changed or proved something first, what only looked last. */
export const BASH_ORDER: BashKind[] = ["tests", "build", "install", "git", "run", "search", "read", "other"];

/** Heredoc bodies are data, not commands: `cat > x <<EOF\npytest\nEOF` runs no tests. */
function dropHeredocs(src: string): string {
  const lines = src.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(lines[i]);
    if (!m) continue;
    while (i + 1 < lines.length && lines[i + 1].trim() !== m[2]) i++;
    i++;
  }
  return out.join("\n");
}

/** The simple commands of a line, each as its words with quotes taken off. Cuts at
 *  `&&`, `||`, `;`, `|`, `&`, newlines and parentheses, but never inside quotes. */
export function bashSegments(command: string): string[][] {
  const src = dropHeredocs(command);
  const out: string[][] = [];
  let words: string[] = [], word = "", has = false, quote = "";
  const endWord = () => { if (has) words.push(word); word = ""; has = false; };
  const endSeg = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < src.length) word += src[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\") {
      if (src[i + 1] === "\n") i++;
      else if (i + 1 < src.length) { word += src[++i]; has = true; }
      continue;
    }
    if (c === "&" && (src[i + 1] === ">" || src[i - 1] === ">")) { word += c; has = true; continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") { endSeg(); continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    word += c;
    has = true;
  }
  endSeg();
  return out;
}

const base = (w: string) => w.split("/").pop() ?? w;

/** Words that only wrap the command that follows them, and how many arguments each
 *  of them may take first. */
const WRAP = new Set(["sudo", "time", "command", "exec", "nohup", "nice", "ionice", "stdbuf", "timeout", "env", "xargs", "do", "then", "else", "elif", "if", "while", "until", "!", "{", "npx", "bunx", "pnpx"]);
/** Set-up: says nothing about what a chain was for. */
const NEUTRAL = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "sleep", "true", "false", "echo", "printf", "wait", "alias", "trap", ":", "exit", "fi", "done", "}", "esac", "for", "case", "local", "read"]);

/** The command under its env prefixes and wrappers. */
function unwrap(words: string[]): string[] {
  let w = words;
  for (;;) {
    while (w.length && /^[A-Za-z_]\w*\+?=/.test(w[0])) w = w.slice(1);
    if (!w.length) return w;
    const head = base(w[0]);
    if (!WRAP.has(head)) break;
    w = w.slice(1);
    // the wrapper's own flags, and timeout's duration or nice's level
    while (w.length && (w[0].startsWith("-") || (head === "timeout" && /^\d/.test(w[0])))) {
      const takes = /^-(n|k|s|u|g|I|L|P)$/.test(w[0]);
      w = w.slice(takes ? 2 : 1);
    }
  }
  const head = base(w[0]);
  // uv run pytest, poetry run pytest, pnpm exec jest: what they run is the command.
  if ((head === "uv" || head === "poetry" || head === "pipenv" || head === "hatch" || head === "rye") && w[1] === "run") return unwrap(w.slice(2));
  if ((head === "pnpm" || head === "yarn" || head === "npm" || head === "bun") && (w[1] === "exec" || w[1] === "x")) return unwrap(w.slice(2).filter((x) => x !== "--"));
  return w;
}

const TEST_BIN = new Set(["pytest", "py.test", "jest", "vitest", "mocha", "ava", "rspec", "phpunit", "tox", "nox", "ctest", "nextest", "karma", "tap"]);
const BUILD_BIN = new Set(["tsc", "webpack", "rollup", "esbuild", "parcel", "tsup", "cmake", "ninja", "gcc", "g++", "clang", "clang++", "rustc", "javac", "swiftc"]);
const SEARCH_BIN = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "fdfind", "find", "locate"]);
const READ_BIN = new Set(["cat", "head", "tail", "less", "more", "bat", "ls", "tree", "wc", "stat", "file", "du", "df", "pwd", "jq", "sed", "awk", "diff", "cut", "sort", "uniq", "nl", "realpath", "readlink", "which", "printenv", "xxd", "hexdump", "date", "whoami", "ps"]);
const RUN_BIN = new Set(["node", "python", "python3", "ruby", "perl", "php", "deno", "bun", "tsx", "ts-node", "bash", "sh", "zsh", "curl", "wget", "docker", "docker-compose", "systemctl", "ssh", "make", "vite", "uvicorn", "gunicorn", "flask", "lua", "java", "go", "cargo", "npm", "yarn", "pnpm", "swift", "dotnet"]);
const TEST_FILE = /(^|[/._-])(test|tests|spec|check)[._-]|[._-](test|tests|spec|check)\.[a-z]+$/i;
const RUN_SCRIPT = /^(test|tests|unit|e2e|integration|check|checks)([:-].*)?$/;
const BUILD_SCRIPT = /^(build|compile|bundle|typecheck|dist)([:-].*)?$/;

function pkgKind(args: string[]): BashKind {
  const a = args.filter((x) => !x.startsWith("-"));
  const verb = a[0] ?? "";
  if (verb === "test" || verb === "t") return "tests";
  if (["i", "install", "ci", "add", "update", "remove", "uninstall", "rm"].includes(verb)) return "install";
  const script = verb === "run" || verb === "run-script" ? a[1] ?? "" : verb;
  if (RUN_SCRIPT.test(script)) return "tests";
  if (BUILD_SCRIPT.test(script)) return "build";
  return script ? "run" : "other";
}

function oneKind(words: string[]): BashKind | null {
  const w = unwrap(words);
  if (!w.length) return null;
  const head = base(w[0]);
  const args = w.slice(1);
  const verb = args.find((x) => !x.startsWith("-")) ?? "";
  if (NEUTRAL.has(head)) return null;
  // bash -c "…": the string is the command.
  if ((head === "bash" || head === "sh" || head === "zsh" || head === "eval") && (head === "eval" || args.some((x) => /^-[a-z]*c$/.test(x)))) {
    const body = head === "eval" ? args.join(" ") : args[args.findIndex((x) => /^-[a-z]*c$/.test(x)) + 1] ?? "";
    return bashKind(body);
  }
  if (TEST_BIN.has(head)) return "tests";
  if (BUILD_BIN.has(head)) return "build";
  if (head === "git") {
    const sub = args.find((x, i) => !x.startsWith("-") && args[i - 1] !== "-C" && args[i - 1] !== "-c");
    return sub === "grep" ? "search" : "git";
  }
  if (head === "gh") return "git";
  if (SEARCH_BIN.has(head)) return "search";
  if (READ_BIN.has(head)) {
    // `cat > f`, `sed -i`: it writes, so it isn't a read.
    if (args.some((x) => /^\d?>>?/.test(x)) || (head === "sed" && args.some((x) => /^-[a-z]*i/.test(x)))) return "other";
    return "read";
  }
  switch (head) {
    case "npm": case "yarn": case "pnpm": return head === "yarn" && !args.length ? "install" : pkgKind(args);
    case "bun": return verb === "test" ? "tests" : verb === "build" ? "build" : ["install", "add", "i"].includes(verb) ? "install" : "run";
    case "python": case "python3": case "py": {
      const m = args.indexOf("-m");
      if (m >= 0) {
        const mod = args[m + 1] ?? "";
        if (mod === "pytest" || mod === "unittest" || mod === "nose2" || mod === "tox") return "tests";
        if (mod === "pip" || mod === "ensurepip") return args.includes("install") ? "install" : "run";
        if (mod === "build" || mod === "compileall") return "build";
        return "run";
      }
      if (args[0] === "manage.py" && args[1] === "test") return "tests";
      const file = args.find((x) => !x.startsWith("-"));
      return file && TEST_FILE.test(file) ? "tests" : "run";
    }
    case "node": case "deno": case "tsx": case "ts-node": {
      if (args.includes("--test") || verb === "test") return "tests";
      const file = args.find((x) => !x.startsWith("-"));
      return file && TEST_FILE.test(file) ? "tests" : "run";
    }
    case "cargo": return verb === "test" || verb === "nextest" ? "tests" : ["build", "check", "clippy"].includes(verb) ? "build" : ["add", "install", "update"].includes(verb) ? "install" : "run";
    case "go": return verb === "test" ? "tests" : ["build", "vet"].includes(verb) ? "build" : ["get", "install"].includes(verb) ? "install" : "run";
    case "swift": case "dotnet": return verb === "test" ? "tests" : verb === "build" ? "build" : "run";
    case "gradle": case "gradlew": case "mvn": case "mvnw":
      return args.some((x) => x === "test" || x === "verify" || x === "check") ? "tests" : args.some((x) => ["build", "assemble", "compile", "package"].includes(x)) ? "build" : "run";
    case "make": case "just": case "rake":
      return args.some((x) => RUN_SCRIPT.test(x)) ? "tests" : !verb || args.some((x) => BUILD_SCRIPT.test(x) || x === "all") ? "build" : "run";
    case "vite": case "next": case "nuxt": case "astro": return verb === "build" ? "build" : "run";
    case "docker": return verb === "build" ? "build" : "run";
    case "pip": case "pip3": case "pipx": case "gem": case "brew": case "apt": case "apt-get": case "dnf": case "yum": case "apk": case "composer":
      return ["install", "add", "require", "upgrade", "update", "remove", "uninstall"].includes(verb) ? "install" : "other";
    case "pacman": case "yay": case "paru": return args.some((x) => /^-[SRU]/.test(x)) ? "install" : "other";
    case "bundle": return verb === "install" ? "install" : verb === "exec" ? "run" : "other";
    case "uv": return verb === "pip" ? (args.includes("install") ? "install" : "other") : ["add", "sync", "remove"].includes(verb) ? "install" : "run";
    case "poetry": return ["add", "install", "remove", "update"].includes(verb) ? "install" : "run";
    case "playwright": case "cypress": return verb === "test" || verb === "run" ? "tests" : "run";
  }
  if (RUN_BIN.has(head)) return "run";
  // ./script, /opt/tool/bin/x: something local was run; a test script says so by name.
  if (w[0].includes("/")) return TEST_FILE.test(w[0]) ? "tests" : "run";
  return "other";
}

// A live turn's header re-counts every command as each event lands, and an agent runs
// the same few over and over.
const seen = new Map<string, BashKind>();

/** The kind of one command line. */
export function bashKind(command: string | undefined | null): BashKind {
  const src = command ?? "";
  const known = seen.get(src);
  if (known) return known;
  let best: BashKind | null = null;
  for (const seg of bashSegments(src)) {
    const k = oneKind(seg);
    if (k && (best === null || BASH_ORDER.indexOf(k) < BASH_ORDER.indexOf(best))) best = k;
  }
  if (seen.size >= 4000) seen.clear();
  seen.set(src, best ?? "other");
  return best ?? "other";
}

/** What a test command's output said. A count it couldn't read is absent. */
export type TestResult = { passed?: number; failed?: number; skipped?: number };

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const lastLine = (lines: string[], re: RegExp): string | undefined => {
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return lines[i];
  return undefined;
};

function num(line: string, re: RegExp): number | undefined {
  const m = re.exec(line);
  return m ? parseInt(m[1], 10) : undefined;
}

/** The runner's own summary, from the common ones: pytest, jest, vitest, mocha,
 *  rspec, cargo, go, node --test. null when none shows: the output is truncated or
 *  it's a runner this doesn't know. Never guesses from the exit code. */
export function testResult(output: string | undefined | null): TestResult | null {
  const lines = (output ?? "").replace(ANSI, "").split("\n");
  // cargo prints one line per test binary, so they add up.
  const cargo = lines.filter((l) => /^test result:/.test(l.trim()));
  if (cargo.length) {
    const sum = (re: RegExp) => cargo.reduce((t, l) => t + (num(l, re) ?? 0), 0);
    return { passed: sum(/(\d+) passed/), failed: sum(/(\d+) failed/), skipped: sum(/(\d+) ignored/) };
  }
  // node --test: "# pass 3" or "ℹ pass 3".
  const nodePass = lastLine(lines, /^\s*(#|ℹ)\s*pass \d+/);
  if (nodePass) {
    const nodeFail = lastLine(lines, /^\s*(#|ℹ)\s*fail \d+/);
    const nodeSkip = lastLine(lines, /^\s*(#|ℹ)\s*skipped \d+/);
    return { passed: num(nodePass, /pass (\d+)/), failed: nodeFail ? num(nodeFail, /fail (\d+)/) : 0, skipped: nodeSkip ? num(nodeSkip, /skipped (\d+)/) : undefined };
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/Test Suites?:|Test Files/.test(l)) continue;     // jest and vitest count files on their own line
    if (!/\b\d+\s+(passed|failed)\b/.test(l)) continue;
    const err = num(l, /(\d+) errors?\b/) ?? 0;
    const failed = num(l, /(\d+)\s+failed/);
    return { passed: num(l, /(\d+)\s+passed/), failed: failed === undefined && !err ? undefined : (failed ?? 0) + err, skipped: num(l, /(\d+)\s+skipped/) };
  }
  // mocha: two lines, "5 passing" and "1 failing".
  const passing = lastLine(lines, /^\s*\d+ passing\b/);
  if (passing) {
    const failing = lastLine(lines, /^\s*\d+ failing\b/);
    const pending = lastLine(lines, /^\s*\d+ pending\b/);
    return { passed: num(passing, /(\d+) passing/), failed: failing ? num(failing, /(\d+) failing/) : 0, skipped: pending ? num(pending, /(\d+) pending/) : undefined };
  }
  // rspec: "5 examples, 1 failure, 2 pending".
  const rspec = lastLine(lines, /\b\d+ examples?, \d+ failures?/);
  if (rspec) {
    const total = num(rspec, /(\d+) examples?/) ?? 0, failed = num(rspec, /(\d+) failures?/) ?? 0, skipped = num(rspec, /(\d+) pending/);
    return { passed: total - failed - (skipped ?? 0), failed, skipped };
  }
  // go test: a line per package and one per failing test.
  const goOk = lines.filter((l) => /^ok\s+\S+/.test(l)).length;
  const goFail = lines.filter((l) => /^--- FAIL:/.test(l.trim())).length;
  const goPkgFail = lines.filter((l) => /^FAIL\s+\S+/.test(l)).length;
  if (goOk || goFail || goPkgFail) return { passed: goOk, failed: goFail || goPkgFail };
  return null;
}

/** "3301 passed, 7 failed"; "" when there's nothing to say. Zero failures and
 *  zero skips aren't news. */
export function testLine(r: TestResult | null | undefined): string {
  if (!r) return "";
  return [
    r.passed !== undefined ? `${r.passed} passed` : "",
    r.failed ? `${r.failed} failed` : "",
    r.skipped ? `${r.skipped} skipped` : "",
  ].filter(Boolean).join(", ");
}
