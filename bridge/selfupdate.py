"""Update the platform itself: is this checkout behind its upstream, and if so
pull the new commits and restart the bridge.

The bridge always runs from its git checkout (run.sh execs
claude_telegram_bridge.py by absolute path from it), so "update" is a
`git pull --ff-only` there followed by a restart of this process. The restart
reuses the normal SIGINT path — clean shutdown, then `os.execv` re-runs the same
interpreter/argv/env in place, so the PID (and `mystical`'s pidfile) survives and
startup recovery resumes the turns the restart interrupted. Stdlib only.

The same restart also carries the Claude CLI's own update, for when a new model
outruns the installed CLI and the API starts refusing it. `claude update` runs
in the gap between shutdown and re-exec, once the Claude children are stopped.
Running it by hand with the bridge up lagged the whole machine (2026-09-22).

Going live (the right rail's ⟳, docs/superpowers/specs/go-live.md) is that build and
restart without the pull, for code already on disk: a session merged it, or edited this
checkout. Each part knows the tree it runs, as a commit. The bridge snapshots its own as
it launches (`boot`); each web build stamps its dist/ (the vite configs' builtFrom
plugin). `live` diffs them against the tree. The snapshot is `git stash create`, which is
HEAD plus the uncommitted edits, touching nothing. HEAD alone would show an edit that was
already on disk at launch as new. Only what a part loads counts: the bridge's Python, an
app's web dir. Tests and docs need nothing.
"""

import os
import re
import signal
import subprocess
import sys
import threading
import time

from bridge import browser, git, runner, state, store

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Set by restart(); read by the entry point after its shutdown finishes.
restart_requested = False
# Set by update_claude(); the entry point runs run_claude_update() before re-exec.
claude_update_requested = False


def project() -> str:
    """This checkout named the way sessions name projects, so FIX WITH CLAUDE and the
    changelog's Ask Claude start their sessions here; "" outside BASE_PATH, where no
    session can run."""
    real = os.path.realpath(REPO)
    return browser.rel(real) if browser.within_base(real) else ""


def check() -> dict:
    """Fetch, then report what this checkout is out of sync on — theirs (commits
    waiting upstream) and ours (uncommitted changes, unpushed commits)."""
    if not git.is_repo(REPO):
        return {"repo": False, "path": REPO, "branch": "", "behind": 0,
                "ahead": 0, "dirty": 0, "commits": [], "outgoing": [], "files": []}
    git.fetch(REPO)
    st = git.status(REPO)
    return {"repo": True, "path": REPO, "branch": st["branch"], "project": project(),
            "behind": st["behind"], "ahead": st["ahead"], "dirty": st["dirty"],
            "commits": git.incoming(REPO), "outgoing": git.outgoing(REPO),
            "files": st["files"][:50]}


# Mini App first: if its build fails, the dashboard's bundle still matches the running Python.
_build_lock = threading.Lock()   # one npm build at a time: UPDATE and going live write the same dist/
_WEB_UIS = [("Mini App", os.path.join(REPO, "bridge", "miniapp", "web")),
            ("dashboard", os.path.join(REPO, "bridge", "dashboard", "web"))]


def _deps_stale(web: str) -> bool:
    """npm records the tree it installed in node_modules/.package-lock.json, so a
    lockfile newer than that means a pull changed deps. bin/mystical's rule."""
    try:
        lock = os.path.getmtime(os.path.join(web, "package-lock.json"))
    except OSError:
        return False
    try:
        return lock > os.path.getmtime(os.path.join(web, "node_modules", ".package-lock.json"))
    except OSError:
        return True


def _build(name: str, web: str) -> tuple[bool, str]:
    """Rebuild one UI's bundle. dist/ is generated, not committed, so a pull
    that changes the UI would otherwise keep serving the old (or a deleted) one.
    No node_modules → nothing we can build; leave what's on disk. Deps a pull
    changed install first: the build fails on a module it added (2026-10-28)."""
    if not os.path.isdir(os.path.join(web, "node_modules")):
        return True, f"{name} build skipped (no node_modules)"
    try:
        with _build_lock:
            if _deps_stale(web):
                p = subprocess.run(["npm", "install"], cwd=web,
                                   capture_output=True, text=True, timeout=300)
                if p.returncode != 0:
                    return False, "npm install failed:\n" + (p.stdout + p.stderr).strip()[-2000:]
            p = subprocess.run(["npm", "run", "build"], cwd=web,
                               capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return p.returncode == 0, (p.stdout + p.stderr).strip()[-2000:]


def update() -> tuple[bool, str, bool]:
    """Pull, rebuild both UIs, then arm the restart (delayed, so the caller's HTTP
    response still gets out). A failed pull or build restarts nothing. The last
    value says whether the pull landed, so a failed build isn't read as a refused pull."""
    ok, output = git.pull(REPO)
    if not ok:
        return False, output, False
    for name, web in _WEB_UIS:
        built, build_out = _build(name, web)
        if not built:
            return False, f"{output}\n\n{name} build failed:\n{build_out}", True
    restart()
    return True, output, True


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
    if restart_requested:
        return   # one is already on its way; a second SIGINT would land mid-shutdown
    restart_requested = True
    threading.Timer(delay, lambda: os.kill(os.getpid(), signal.SIGINT)).start()


def update_claude() -> None:
    global claude_update_requested
    claude_update_requested = True
    restart()


def run_claude_update() -> None:
    """Stop the Claude children, then install the new CLI. Their turns stay
    'running' (shutdown has set state.shutting_down), so boot recovery resumes
    them on the new binary. A failed update still restarts, because getting the
    bridge back matters more. The output goes to the bridge log."""
    runner.stop_children()
    try:
        p = subprocess.run([runner.claude_bin(), "update"], capture_output=True,
                           text=True, timeout=300)
        print(f"claude update → {p.returncode}\n{(p.stdout + p.stderr).strip()}")
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"claude update failed: {e}", file=sys.stderr)


def exec_self() -> None:
    """Replace this process with a fresh one — same interpreter, argv, env, cwd."""
    os.execv(sys.executable, [sys.executable, os.path.abspath(sys.argv[0])])


# --- go live: what's on disk but not running (the rail's ⟳) ---------------------------

BOOT = ""          # the tree this process launched with (snapshot()); "" until boot()
BOOT_HEAD = ""     # the commit under it, which is what the card names
STARTED = 0.0
_PY = ["bridge/*.py", "claude_telegram_bridge.py"]   # what a restart loads; a pathspec's * spans dirs
_APPS = [("miniapp", "Mini App", "bridge/miniapp/web"), ("dashboard", "Dashboard", "bridge/dashboard/web")]
_AFTER_EVERY = 3.0                                    # seconds between looks at the turns a wait is on
_live_lock = threading.Lock()
_after: dict = {}  # the armed wait: {"token", "jobs": [(job id, session id)], "restarting"}; empty when none
_error: dict = {}  # what the wait's build said when it failed, until CLOSE drops it


def snapshot() -> str:
    """This tree as a commit: `git stash create`, which records HEAD plus every
    uncommitted edit to a tracked file without touching the tree or the stash list.
    Plain HEAD when there's nothing uncommitted; "" outside a repo."""
    # shortcut: stash create briefly takes the index lock, so a git holding it at that
    # instant makes HEAD stand in (dirty edits then read as new); a temp GIT_INDEX_FILE
    # + write-tree + commit-tree avoids the lock if that ever bites.
    rc, out, _ = git._run(REPO, "stash", "create")
    return out.strip() if rc == 0 and out.strip() else git.head_sha(REPO)


def boot() -> None:
    """Take the tree this process is about to run. The entry point calls it as it starts."""
    global BOOT, BOOT_HEAD, STARTED
    BOOT, BOOT_HEAD, STARTED = snapshot(), git.head_sha(REPO), time.time()


def _behind(base: str, paths: list[str]) -> "dict | None":
    """What changed in `paths` since the tree `base`, or None when nothing did. Returns
    the commits since (newest first), how many of the changed files are uncommitted, and
    how many changed in all: a move off the branch changes files with no commit to show.
    A base git doesn't know (pruned, or never stamped) is behind by definition."""
    rc, out, _ = git._run(REPO, "diff", "--name-only", base, "--", *paths)
    if rc == 128:                      # a base git doesn't know
        return {"commits": [], "dirty": 0, "files": 0, "unknown": True}
    if rc != 0:                        # git slow or gone: can't tell, so say nothing
        return None
    files = out.splitlines()
    if not files:
        return None
    _, log, _ = git._run(REPO, "log", "-n", "100", "--format=%h%x09%ct%x09%s", f"{base}..HEAD", "--", *paths)
    commits = [{"sha": c[0], "at": int(c[1]), "subject": c[2]}
               for c in (line.split("\t", 2) for line in log.splitlines()) if len(c) == 3]
    _, wt, _ = git._run(REPO, "diff", "--name-only", "HEAD", "--", *paths)
    return {"commits": commits, "dirty": len(set(wt.splitlines()) & set(files)), "files": len(files)}


def _built(web: str) -> tuple[str, float]:
    """An app's build stamp (the tree its dist/ came from) and when it was built (0 never).
    The stamp reaches git's argv, so only a bare sha passes."""
    dist = os.path.join(REPO, web, "dist")
    try:
        with open(os.path.join(dist, ".built")) as f:
            stamp = f.read().strip()
    except OSError:
        stamp = ""
    if not re.fullmatch(r"[0-9a-f]{40,64}", stamp):
        stamp = ""
    try:
        at = os.path.getmtime(os.path.join(dist, "index.html"))
    except OSError:
        at = 0.0
    return stamp, at


def _turn(sid: str, job) -> dict:
    return {"id": sid, "title": (store.get_session(sid) or {}).get("title") or "untitled", "started": job.started}


def live() -> dict:
    """What's on disk but not running, part by part: each web app since its build, the
    bridge since it launched. Also the turns a restart would stop, a wait armed for
    them, and what a failed wait said. No network, so the rail can poll it."""
    if not git.is_repo(REPO):
        return {"repo": False, "parts": [], "commits": 0, "turns": [], "queued": None, "error": None}
    parts = []
    for key, name, web in _APPS:
        stamp, at = _built(web)
        if not at:
            continue                   # never built here (a Mini App turned off): nothing served to update
        got = _behind(stamp, [web]) if stamp else {"commits": [], "dirty": 0, "files": 0, "unknown": True}
        if got:
            parts.append({"key": key, "name": name, "act": "rebuild", "since": at, **got})
    got = _behind(BOOT, _PY) if BOOT else None
    if got:
        parts.append({"key": "bridge", "name": "Bridge", "act": "restart", "since": STARTED, **got})
    turns = sorted((_turn(s, j) for s in state.running_sessions() if (j := runner.live_job(s))),
                   key=lambda t: t["started"])
    with _live_lock:
        waits = list(_after["jobs"]) if _after else None
        restarting = bool(_after.get("restarting"))
        error = dict(_error) or None
    queued = None if waits is None else {"turns": [_turn(s, j) for jid, s in waits if (j := runner.get_job(jid))],
                                         "restarting": restarting}
    return {"repo": True, "path": REPO, "project": project(), "branch": git.current_branch_cached(REPO),
            "running": BOOT_HEAD[:7], "disk": git.head_sha(REPO)[:7],
            "parts": parts, "commits": len({c["sha"] for p in parts for c in p["commits"]}),
            "turns": turns, "queued": queued, "error": error}


def build(key: str) -> dict:
    """Rebuild one web app, timed: one step of going live. No node_modules is a failure
    here, not UPDATE's quiet skip, because a skip would leave ⟳ lit for good."""
    app = next((a for a in _APPS if a[0] == key), None)
    if not app:
        return {"ok": False, "output": f"no app {key!r}", "seconds": 0}
    if restart_requested:              # an npm left running across the exec would write dist/ under the next process
        return {"ok": False, "output": "A restart is already on its way. Go live again once it's back.", "seconds": 0}
    web = os.path.join(REPO, app[2])
    if not os.path.isdir(os.path.join(web, "node_modules")):
        return {"ok": False, "output": f"{app[1]}: no node_modules here. `mystical build` installs them.", "seconds": 0}
    t = time.time()
    ok, out = _build(app[1], web)
    return {"ok": ok, "output": "" if ok else out, "seconds": round(time.time() - t)}


def go(still=lambda: True) -> tuple[bool, str, str]:
    """Build every app that's behind, then restart if the bridge is. This is how a wait
    ends; the rail's own REBUILD & RESTART runs the same steps as separate requests, so
    each one reports. The first failure stops it: (False, its name, its output).
    `still()` is asked before each step, so a cancel stops it short of the restart."""
    if restart_requested:
        return True, "", ""
    parts = live()["parts"]
    for p in parts:
        if not still():
            return True, "", ""
        if p["act"] == "rebuild":
            r = build(p["key"])
            if not r["ok"]:
                return False, p["name"], r["output"]
    if still() and any(p["act"] == "restart" for p in parts):
        restart()
    return True, "", ""


def after(cancel: bool = False) -> None:
    """Go live once the turns running now have ended (the rail's AFTER N TURNS). It waits
    on those turns only. One that starts meanwhile, even in the same session, stops for
    the restart and resumes, as in any restart. CANCEL and CLOSE send `cancel`, which
    also drops a failed wait's error."""
    with _live_lock:
        if cancel:
            _after.clear()
            _error.clear()
            return
        if _after:
            return
        token = object()
        _after.update(token=token, jobs=[(j.id, s) for s in state.running_sessions() if (j := runner.live_job(s))])
        _error.clear()
    threading.Thread(target=_wait, args=(token,), daemon=True, name="go-live-after").start()


def _wait(token: object) -> None:
    """One armed wait, known by its token: a cancel, or a newer wait armed after one,
    leaves this thread holding a token that's no longer there, and it stops."""
    def mine() -> bool:
        with _live_lock:
            return _after.get("token") is token
    while True:
        with _live_lock:
            if _after.get("token") is not token:
                return
            _after["jobs"] = [(jid, s) for jid, s in _after["jobs"]
                              if (j := runner.get_job(jid)) and j.status == "running"]
            if not _after["jobs"]:
                break
        time.sleep(_AFTER_EVERY)
    try:
        ok, name, out = go(mine)
    except Exception as e:  # noqa: BLE001 — a wait must not die silently with ⟳ still clocked
        ok, name, out = False, "Going live", str(e)
    with _live_lock:
        if _after.get("token") is not token:
            return
        if ok and restart_requested:
            _after["restarting"] = True   # held until the exec, so the page's next poll meets the restart
        else:
            _after.clear()
            if not ok:
                _error.update(name=name, output=out)
