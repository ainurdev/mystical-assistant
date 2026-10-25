"""The push gate, and each branch's task answer, for repos on a Rivendell board
(docs/superpowers/specs/rivendell-task-check.md).

A session in such a repo asks about a task once, before the first push of work
no task covers (runner._RIVENDELL_NOTE). This holds it to that without trusting
the model to remember: a PreToolUse hook on Bash, put on the run by
runner._base_cmd as `python -I bridge/taskcheck.py <repo id> <key prefixes>`.
It holds back a `git push` or `gh pr create` from the board repo that carries
no task key (not in the branch, the commits no remote has yet, or the command)
once per branch, with words that send Claude to the card. The retry goes
through, so "not a task" never loops, and a misfire costs one retry, never a
stuck push.

Each checkout keeps the answers in .mystical/tasks.json (branch -> "asked",
"skip" or a task key). The hook is a separate process with no bridge to ask,
and the task tab (rivendell.task_state) reads the same file, so the two agree
and a restart forgets nothing. A feature branch is one piece of work, so its
answer lasts as long as the branch. The default branch carries one piece of
work after another, so its answer is kept under `main@<commit>` (slot): one
"Not a task" on main once switched the check off there for good.

Stdlib only, nothing from bridge/: the hook runs this file as a script under -I.
Not built: a git pre-push hook would catch terminal pushes too, but it means
writing into client repos' .git/hooks. A permission `ask` rule would put a card
on every push, not just on the first keyless one."""

import json
import os
import re
import shlex
import subprocess
import sys

STATE = os.path.join(".mystical", "tasks.json")
_GIT_TIMEOUT = 5
# A key a person wrote, in any case: "It's nra-51" on a card, a lowercased branch.
_ANY_KEY = re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]{1,9}-\d+(?!\d)")
_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SEP = re.compile(r"&&|\|\||[;|&\n]")
_NOT_WORK = {"--delete", "-d", "--tags", "--mirror", "--prune"}

HELD = ("Held once: this repo's work is tracked on a Rivendell board, and nothing in this push "
        "names a task (no key in the branch, its new commits or the command). Ask the user with "
        "the Task card your instructions describe, then push again. If they already said this "
        "isn't a task, just push again: a branch is only held once.")


def key_re(prefixes=()) -> "re.Pattern":
    """A task key. With the board's prefixes, in any case: Rivendell matches keys
    case-insensitively, and a repo's branch style may lowercase them. Without
    them, all caps only, so `utf-8` in a branch name isn't taken for one."""
    if prefixes:
        alts = "|".join(re.escape(p) for p in sorted(set(prefixes), key=len, reverse=True))
        return re.compile(rf"(?<![A-Za-z0-9])(?:{alts})-\d+(?!\d)", re.I)
    return re.compile(r"(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d+(?!\d)")


def _git(d: str, *args: str) -> str:
    try:
        r = subprocess.run(["git", "-C", d, *args], capture_output=True, text=True,
                           timeout=_GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def toplevel(cwd: "str | None") -> str:
    return _git(cwd, "rev-parse", "--show-toplevel") if cwd and os.path.isdir(cwd) else ""


def repo_id(cwd: "str | None") -> str:
    """The repo a checkout belongs to: its git common dir, which every linked
    worktree shares, so a session that moves into one is still gated."""
    if not cwd or not os.path.isdir(cwd):
        return ""
    d = _git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return os.path.realpath(d) if d else ""


def branch(top: str) -> str:
    b = _git(top, "rev-parse", "--abbrev-ref", "HEAD") if top else ""
    return "" if b == "HEAD" else b        # detached: no branch to hold or answer for


def has_work(top: str) -> bool:
    """Something to push: commits no remote has, or changes not committed yet."""
    return bool(_git(top, "status", "--porcelain")
                or _git(top, "rev-list", "-n", "1", "HEAD", "--not", "--remotes"))


def slot(top: str, br: str) -> str:
    """The key a branch's answer is kept under. On the default branch (the one
    origin's HEAD names; main or master when it names none) it also carries the
    commit the work sits on, HEAD's merge-base with its upstream: once the push
    lands that commit moves, and the next work there asks again. A background
    fetch doesn't move it. Any other branch: the branch name.
    shortcut: a pull or rebase between the answer and the push moves it too, so
    that push is held once more. Key on the work's first commit if that bites."""
    head = _git(top, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")
    if not br or br not in ({head.split("/", 1)[1]} if "/" in head else {"main", "master"}):
        return br
    base = _git(top, "merge-base", "HEAD", "@{upstream}")
    return f"{br}@{base[:12]}" if base else br


def read(top: str) -> dict:
    try:
        with open(os.path.join(top, STATE), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def record(top: str, br: str, value: str) -> None:
    """One branch's answer: "asked", "skip" or a key, under its slot. "asked"
    only marks a branch with no answer yet; it never undoes one. The default
    branch keeps only its newest answer: the older ones were for work that has
    landed. Best-effort."""
    if not (top and br and value):
        return
    key = slot(top, br)
    d = read(top)
    if value == "asked" and d.get(key):
        return
    if key != br:
        d = {k: v for k, v in d.items() if k != br and not k.startswith(br + "@")}
    d[key] = value
    path = os.path.join(top, STATE)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        gi = os.path.join(os.path.dirname(path), ".gitignore")
        if not os.path.exists(gi):           # as devserver.mystical_dir: never in git status
            with open(gi, "w", encoding="utf-8") as f:
                f.write("*\n")
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1, sort_keys=True)
        os.replace(tmp, path)
    except OSError:
        pass


def push_dir(command: str, cwd: str) -> "str | None":
    """Where `command` pushes work from, or None when it doesn't: a `git push`
    (after `-C dir` or a `cd dir` earlier in the line) or a `gh pr create`. A
    push that only deletes a branch or sends tags isn't work.
    shortcut: splits on shell separators before quoting, so `--title "a; b"`
    breaks in two. The push's own segment still parses, and that's all this
    needs. A real shell parser would be needed for subshells or `$(...)`."""
    d = cwd
    for seg in _SEP.split(command or ""):
        try:
            toks = shlex.split(seg)
        except ValueError:
            toks = seg.split()
        if toks[:1] == ["env"]:
            toks = toks[1:]
        while toks and _ASSIGN.match(toks[0]):
            toks = toks[1:]
        if not toks:
            continue
        exe = os.path.basename(toks[0])
        if exe == "cd" and len(toks) == 2:
            d = os.path.join(d, os.path.expanduser(toks[1]))
        elif exe == "gh" and toks[1:3] == ["pr", "create"]:
            return d
        elif exe == "git":
            i, here = 1, d
            while i < len(toks) and toks[i].startswith("-"):
                if toks[i] in ("-C", "-c") and i + 1 < len(toks):
                    if toks[i] == "-C":
                        here = os.path.join(here, os.path.expanduser(toks[i + 1]))
                    i += 1
                i += 1
            rest = toks[i + 1:]
            if toks[i:i + 1] == ["push"] and not (_NOT_WORK & set(rest)
                                                  or any(a.startswith(":") for a in rest)):
                return here
    return None


def gate(cwd: str, command: str, home: str, prefixes=()) -> "str | None":
    """The words that hold this Bash command back, or None to let it run."""
    d = push_dir(command, cwd)
    if d is None or not home or repo_id(d) != os.path.realpath(home):
        return None
    top = toplevel(d)
    br = branch(top)
    if not br or read(top).get(slot(top, br)):
        return None
    rx = key_re(prefixes)
    if rx.search(br) or rx.search(command):
        return None
    if rx.search(_git(top, "log", "-n", "50", "--format=%B", "HEAD", "--not", "--remotes")):
        return None
    record(top, br, "asked")
    return HELD


def answer_state(questions, answers) -> "str | None":
    """What an answered Task card decided: "skip" for Not a task, the key for
    "It's KEY …", else None. A create records its own key (rivendell.work_create)."""
    q = next((q for q in questions or [] if isinstance(q, dict)
              and str(q.get("header") or "").strip().lower() == "task"), None)
    if q is None:
        return None
    answers = [a for a in answers or [] if isinstance(a, dict)]
    a = next((a for a in answers if a.get("header") == q.get("header")), None)
    if a is None and len(answers) == 1 and len(questions) == 1:
        a = answers[0]                       # as runner._format_answers reads one answer
    for label in (a or {}).get("labels") or []:
        s = str(label).strip()
        if s.lower().startswith("not a task"):
            return "skip"
        m = _ANY_KEY.search(s) if re.match(r"it[’']?s\b", s, re.I) else None
        if m:
            return m.group(0).upper()
    return None


def main(argv) -> int:
    """PreToolUse hook. argv: the board repo's id, its key prefixes comma-joined;
    the event on stdin. Exit 2 with the reason on stderr holds the call (Claude
    reads the reason). Anything else, a broken event included, lets it run."""
    try:
        ev = json.load(sys.stdin)
        if ev.get("tool_name") != "Bash":
            return 0
        prefixes = [p for p in (argv[1] if len(argv) > 1 else "").split(",") if p]
        msg = gate(ev.get("cwd") or os.getcwd(), (ev.get("tool_input") or {}).get("command") or "",
                   argv[0] if argv else "", prefixes)
    except Exception:  # noqa: BLE001 — a broken hook must never block work
        return 0
    if msg:
        print(msg, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
