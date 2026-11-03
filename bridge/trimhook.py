"""Trim a test run's output to its failures: Savers' "Trim test output" (bridge/savers.py).

Run two ways, both stdlib only, both with `python3 -I`:

  as a PreToolUse hook (no argument): reads the Bash call Claude Code is about to
  make. A plain test-runner command (pytest, vitest, jest, go test, ...) comes back
  as updatedInput, wrapped to pipe its output through the filter below with
  pipefail on, so the run still exits with the tests' own status. No permission
  decision is returned: the normal permission flow is untouched.

  --filter: reads the output on stdin. Short output passes through whole. Long
  output keeps every line that looks like a failure (with a little context) and
  the last lines, where every runner prints its summary, so "1007 passed" and a
  traceback both survive while thousands of passing lines don't.

What it leaves alone: a command that already pipes or redirects its output (Claude
is trimming it already), one sent to the background, and anything that isn't a
test runner. Anthropic documents the same hook as a cost lever ("Manage costs").
"""

import json
import re
import sys

_RUNNER = re.compile(
    r"(?:^|[;&]\s*|&&\s*|\bthen\s+)\s*(?:[\w./~-]*/)?(?:"
    r"pytest|python3?\s+-m\s+pytest|vitest|jest|npx\s+(?:vitest|jest)|"
    r"(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+test)\b")
_FAIL = re.compile(r"FAIL|ERROR|Error:|error:|Traceback|AssertionError|assert |✗|✕|● |panic:|^E\s{3}")
SHORT = 80        # output this short is never trimmed
TAIL = 20         # the summary lines every runner prints last
BEFORE, AFTER = 2, 6
CAP = 220


def wrap(command: str, me: str) -> "str | None":
    """The command piped through the filter, or None to leave it alone."""
    if not _RUNNER.search(command) or "|" in command or re.search(r"(?<![0-9&])>", command):
        return None
    return f"( set -o pipefail; {{ {command}\n}} 2>&1 | {sys.executable} -I {me} --filter )"


def trim(lines: list) -> list:
    if len(lines) <= SHORT:
        return lines
    keep = set(range(len(lines) - TAIL, len(lines)))
    for i, line in enumerate(lines):
        if _FAIL.search(line):
            keep.update(range(max(0, i - BEFORE), min(len(lines), i + AFTER + 1)))
    out, last = [], -1
    for i in sorted(keep):
        if i > last + 1:
            out.append(f"… {i - last - 1} lines trimmed (passing output) …")
        out.append(lines[i])
        last = i
    if len(out) > CAP:
        out = out[:CAP - TAIL - 1] + [f"… {len(out) - CAP + 1} more kept lines trimmed …"] + out[-TAIL:]
    return out


def main() -> int:
    if sys.argv[1:] == ["--filter"]:
        sys.stdout.write("\n".join(trim(sys.stdin.read().splitlines())) + "\n")
        return 0
    try:
        call = json.load(sys.stdin)
    except ValueError:
        return 0
    inp = call.get("tool_input") or {}
    if call.get("tool_name") != "Bash" or inp.get("run_in_background"):
        return 0
    new = wrap(str(inp.get("command") or ""), __file__)
    if new:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                 "updatedInput": {**inp, "command": new}}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
