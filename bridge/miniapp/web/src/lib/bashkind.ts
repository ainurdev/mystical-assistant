// What a shell command was for. Bash is most of the tool calls in a turn, so "14
// commands" says nothing; "2 test runs · 3 git · 1 build" says what the turn did.
//
// Not lib/tools cmdKind: that one picks a glyph from the leading binary and has
// fourteen answers. This one reads the whole line (`cd x && pytest | tail` is a test
// run), and folds to the eight words a phone's one-line summary can afford. Quoted
// text is removed first, so `echo "npm test"` and `grep pytest f` aren't test runs.
// Pure.

export type BashKind = "tests" | "build" | "git" | "search" | "read" | "install" | "run" | "other";

/** The strongest wins when a line does several things: `npm i && npm test` is a test
 *  run, and `git log | grep x` is git. */
const RANK = ["tests", "build", "install", "git", "run", "search", "read"] as const;

const RULES: Record<Exclude<BashKind, "other">, RegExp> = {
  tests: new RegExp(
    "^(pytest|py\\.test|tox|nox|vitest|jest|mocha|ava|phpunit|rspec|unittest|ctest|playwright test|go test|cargo (test|nextest)"
    + "|(npm|pnpm|yarn|bun)( run)? test\\S*|npm t|deno test|make (test|check)\\S*|swift test|dotnet test|gradle test|mvn test"
    + "|rake test|(bin/)?rails test|php artisan test)(\\s|$)"
    + "|^(node|tsx|ts-node|bun|deno run)\\b.*\\.(check|test|spec)\\.[cm]?[jt]sx?(\\s|$)",
  ),
  build: new RegExp(
    "^(tsc|vite build|webpack|rollup|esbuild|parcel build|next build|make|cmake|ninja|cargo (build|check)|go build|gcc|clang"
    + "|(npm|pnpm|yarn|bun)( run)? \\S*build\\S*|swift build|dotnet build|docker( compose)? build|gradle build|mvn (package|compile))(\\s|$)",
  ),
  install: new RegExp(
    "^(npm (i|install|ci)|pnpm (i|install|add)|yarn (add|install)|yarn$|bun (i|install|add)|pip3? install|uv (pip install|add|sync)"
    + "|poetry (add|install)|brew install|apt(-get)? install|pacman -S\\S*|cargo add|go get|gem install|composer (install|require))(\\s|$)",
  ),
  git: /^(git|gh)(\s|$)/,
  run: new RegExp(
    "^(python3?|node|ruby|php|perl|bash|sh|zsh|deno|bun|tsx|ts-node|cargo run|go run|curl|wget|docker( compose)? (run|up|exec)"
    + "|(npm|pnpm|yarn)( run)? \\S+|\\.{0,2}/\\S+)(\\s|$)",
  ),
  search: /^(grep|egrep|fgrep|rg|ag|ack|find|fd|locate)(\s|$)/,
  read: /^(cat|bat|head|tail|sed -n|less|more|ls|tree|wc|stat|file|du|pwd|awk|cut|sort|uniq|jq|diff|readlink|realpath)(\s|$)/,
};

/** Wrappers that say nothing about what the line does. */
const WRAP = new RegExp(
  "^(?:\\w+=\\S*\\s+|sudo\\s+|time\\s+|env\\s+|nice\\s+|nohup\\s+|exec\\s+|command\\s+|timeout\\s+\\S+\\s+|npx\\s+(?:-\\S+\\s+)*"
  + "|pnpm exec\\s+|yarn exec\\s+|bunx\\s+|bun x\\s+|uv run\\s+|poetry run\\s+|\\S*node_modules/\\.bin/|python3?\\s+-m\\s+)",
);

function parts(command: string): string[] {
  const bare = command
    .replace(/<<-?\s*(\S+)[\s\S]*$/, "")          // a heredoc's body is data, not commands
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/\d?>&\d/g, "");
  return bare.split(/&&|\|\||[;|&\n]/).map((s) => {
    let t = s.trim().replace(/^\(+\s*/, "");
    for (let prev = ""; prev !== t;) { prev = t; t = t.replace(WRAP, ""); }
    return t;
  }).filter(Boolean);
}

export function bashKind(command: string): BashKind {
  const segs = parts(command);
  for (const kind of RANK) if (segs.some((s) => RULES[kind].test(s))) return kind;
  return "other";
}

/** The first thing the line does that isn't getting there: names an `other` or a
 *  `run` narrowly enough to tell a retry from a different command. */
export function bashHead(command: string): string {
  const seg = parts(command).find((s) => !/^(cd|export|set|source|\.)(\s|$)/.test(s)) ?? "";
  return seg.split(/\s+/).slice(0, 2).join(" ");
}

export type TestCounts = { passed?: number; failed?: number; skipped?: number };

const lastNum = (text: string, re: RegExp): number | undefined => {
  const all = [...text.matchAll(re)];
  return all.length ? Number(all[all.length - 1][1]) : undefined;
};

/** The numbers a test runner printed, or null if there are none to read. It only
 *  ever sees what the turn kept of the output, and the last figure wins: jest and
 *  vitest print their suites first and their tests after. Same reading as
 *  bridge/gateway_tools.parse_output, plus the line-per-result runners. */
export function parseTests(output: string | undefined): TestCounts | null {
  if (!output) return null;
  const text = output.replace(/\x1b\[[0-9;]*m/g, "").slice(-20000);
  let passed = lastNum(text, /(\d+)\s+(?:tests?\s+)?(?:passed|passing)\b/gi);
  let failed = lastNum(text, /(\d+)\s+(?:tests?\s+)?(?:failed|failing)\b/gi);
  const skipped = lastNum(text, /(\d+)\s+(?:tests?\s+)?(?:skipped|ignored)\b/gi);
  if (passed === undefined && failed === undefined) {
    const oks = (text.match(/^(?:ok\b.*)$/gm) ?? []).length;
    const bad = (text.match(/^(?:not ok\b|--- FAIL:|FAIL\s).*$/gm) ?? []).length;
    if (oks) passed = oks;
    if (bad) failed = bad;
  }
  if (passed === undefined && failed === undefined && skipped === undefined) return null;
  const out: TestCounts = {};
  if (passed !== undefined) out.passed = passed;
  if (failed !== undefined) out.failed = failed;
  if (skipped !== undefined) out.skipped = skipped;
  return out;
}

/** "2 failed · 1005 passed": the failures first, what isn't known left out. */
export function testWords(c: TestCounts): string {
  const bits: string[] = [];
  if (c.failed) bits.push(`${c.failed} failed`);
  if (c.passed !== undefined) bits.push(`${c.passed} passed`);
  if (c.skipped) bits.push(`${c.skipped} skipped`);
  if (!bits.length && c.failed === 0) bits.push("0 failed");
  return bits.join(" · ");
}

const WORD: Record<BashKind, [string, string]> = {
  tests: ["test run", "test runs"],
  build: ["build", "builds"],
  git: ["git", "git"],
  install: ["install", "installs"],
  run: ["run", "runs"],
  other: ["command", "commands"],
  search: ["shell search", "shell searches"],
  read: ["shell read", "shell reads"],
};
const LINE_ORDER: BashKind[] = ["tests", "build", "git", "install", "run", "other", "search", "read"];

/** One stretch's commands as the head of its summary line, with the latest test
 *  result where one was printed: "2 test runs: 1007 passed · 3 git". */
export function bashLine(calls: { command: string; output?: string }[]): string {
  const n = new Map<BashKind, number>();
  let tests: TestCounts | null = null;
  for (const c of calls) {
    const k = bashKind(c.command);
    n.set(k, (n.get(k) ?? 0) + 1);
    if (k === "tests") tests = parseTests(c.output) ?? tests;
  }
  return LINE_ORDER.filter((k) => n.has(k)).map((k) => {
    const count = n.get(k) as number;
    const head = `${count} ${WORD[k][count === 1 ? 0 : 1]}`;
    return k === "tests" && tests ? `${head}: ${testWords(tests)}` : head;
  }).join(" · ");
}
