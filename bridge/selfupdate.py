"""Update the platform itself: is this checkout behind its upstream, and if so
pull the new commits and restart the bridge.

The bridge always runs from its git checkout (run.sh execs
claude_telegram_bridge.py by absolute path from it), so "update" is a
`git pull --ff-only` there followed by a restart of this process. The restart
reuses the normal SIGINT path — clean shutdown, then `os.execv` re-runs the same
interpreter/argv/env in place, so the PID (and `mystical`'s pidfile) survives and
startup recovery resumes the turns the restart interrupted. Stdlib only.
"""

import os
import signal
import subprocess
import sys
import threading

from bridge import git

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Set by restart(); read by the entry point after its shutdown finishes.
restart_requested = False


def check() -> dict:
    """Fetch, then report what this checkout is out of sync on — theirs (commits
    waiting upstream) and ours (uncommitted changes, unpushed commits)."""
    if not git.is_repo(REPO):
        return {"repo": False, "path": REPO, "branch": "", "behind": 0,
                "ahead": 0, "dirty": 0, "commits": [], "files": []}
    git.fetch(REPO)
    st = git.status(REPO)
    return {"repo": True, "path": REPO, "branch": st["branch"],
            "behind": st["behind"], "ahead": st["ahead"], "dirty": st["dirty"],
            "commits": git.incoming(REPO), "files": st["files"][:50]}


_DASH_WEB = os.path.join(REPO, "bridge", "dashboard", "web")


def _build_dashboard() -> tuple[bool, str]:
    """Rebuild the dashboard bundle. dist/ is generated, not committed, so a pull
    that changes the UI would otherwise keep serving the old (or a deleted) one.
    No node_modules → nothing we can build; leave what's on disk."""
    if not os.path.isdir(os.path.join(_DASH_WEB, "node_modules")):
        return True, "dashboard build skipped (no node_modules)"
    try:
        p = subprocess.run(["npm", "run", "build"], cwd=_DASH_WEB,
                           capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"dashboard build failed: {e}"
    return p.returncode == 0, (p.stdout + p.stderr).strip()[-2000:]


def update() -> tuple[bool, str]:
    """Pull, rebuild the UI, then arm the restart (delayed, so the caller's HTTP
    response still gets out). A failed pull or build restarts nothing."""
    ok, output = git.pull(REPO)
    if not ok:
        return False, output
    built, build_out = _build_dashboard()
    if not built:
        return False, f"{output}\n\n{build_out}"
    restart()
    return True, output


def publish(message: str) -> tuple[bool, str]:
    """The other direction: ship this checkout's own work. Commits whatever is
    uncommitted, then pushes. Nothing to commit is fine — the branch may just be
    ahead. No restart: the running code is already this code."""
    if git.status(REPO)["dirty"]:
        ok, out = git.commit(REPO, message)
        if not ok:
            return False, out
    return git.push(REPO)


def restart(delay: float = 0.5) -> None:
    global restart_requested
    restart_requested = True
    threading.Timer(delay, lambda: os.kill(os.getpid(), signal.SIGINT)).start()


def exec_self() -> None:
    """Replace this process with a fresh one — same interpreter, argv, env, cwd."""
    os.execv(sys.executable, [sys.executable, os.path.abspath(sys.argv[0])])
