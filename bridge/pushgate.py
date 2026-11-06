"""The Rivendell push check for an agent that has no hooks of its own.

On Claude the check is a PreToolUse hook on Bash (runner._push_gate, taskcheck.py). An
agent over ACP has no such thing, and the bridge can't see a command it isn't asked
about. What every agent does have is git. So the same check runs as a pre-push hook,
set for that agent's process alone, through git's GIT_CONFIG_* environment: nothing is
written into the repo, and a terminal push of yours isn't affected.

core.hooksPath replaces all of a repo's hooks, so the directory holds one small script
under every hook name, which runs the repo's own hook if it has one. A repo that sets
its own hooksPath (husky) is honoured: `git config --local` doesn't see ours.

Stdlib only; taskcheck's rules about never blocking work apply here too.
"""

import os
import shlex
import stat
import sys

_DIR = os.path.expanduser("~/.mystical/githooks")
HOOKS = ("applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
         "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
         "pre-push", "post-rewrite", "reference-transaction")
_SCRIPT = """#!/bin/sh
name=$(basename "$0")
if [ "$name" = pre-push ] && [ -n "$MYSTICAL_PUSH_HOME" ]; then
  {python} -I {taskcheck} --git-hook "$MYSTICAL_PUSH_HOME" "$MYSTICAL_PUSH_PREFIXES" || exit 1
fi
dir=$(git config --local core.hooksPath 2>/dev/null)
[ -n "$dir" ] || dir="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
"""


def ensure() -> str:
    """The hooks directory, written if it's missing or stale."""
    os.makedirs(_DIR, mode=0o700, exist_ok=True)
    taskcheck = os.path.join(os.path.dirname(os.path.abspath(__file__)), "taskcheck.py")
    body = _SCRIPT.format(python=shlex.quote(sys.executable), taskcheck=shlex.quote(taskcheck))
    for name in HOOKS:
        path = os.path.join(_DIR, name)
        try:
            with open(path, encoding="utf-8") as f:
                if f.read() == body:
                    continue
        except OSError:
            pass
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        os.chmod(path, stat.S_IRWXU)
    return _DIR


def env(cwd: str) -> dict:
    """What to add to an agent's environment. Empty outside a git repo."""
    from bridge import rivendell, taskcheck
    home = taskcheck.repo_id(cwd)
    if not home:
        return {}
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": ensure(),
            "MYSTICAL_PUSH_HOME": home,
            "MYSTICAL_PUSH_PREFIXES": ",".join(rivendell.key_prefixes(cwd))}
