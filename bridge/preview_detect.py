"""Learn how to start a project's dev server for preview.

Hybrid: a fast deterministic heuristic (package manager + dev script + app dir),
falling back to a one-shot headless Claude analysis when the repo is ambiguous —
no root dev script, a monorepo, several candidate apps. Returns a single shell
command *chain* (steps joined with &&) that the dev-server runner executes with a
shell, so "may need multiple commands" projects (cd / install / build / dev) work.
"""

import json
import os
import re

from bridge import native

# Lockfile → package manager (first match wins).
_PMS = [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"), ("package-lock.json", "npm")]
# Common single-app subdirs to look into when the root isn't runnable.
_SUBDIRS = ["web", "app", "frontend", "client", "site", "www", "ui", "site/web"]
# Monorepo parents to scan one level into.
_GLOBS = ["apps", "packages"]
_DEV_SCRIPTS = ("dev", "start", "serve")


def _pm(d: str) -> str:
    for f, name in _PMS:
        if os.path.exists(os.path.join(d, f)):
            return name
    return "npm"


def _scripts(d: str) -> dict:
    try:
        with open(os.path.join(d, "package.json"), encoding="utf-8") as f:
            return (json.load(f) or {}).get("scripts", {}) or {}
    except (OSError, ValueError):
        return {}


def _dev_script(scripts: dict) -> "str | None":
    return next((s for s in _DEV_SCRIPTS if s in scripts), None)


def _chain(root: str, app_dir: str, pm: str, script: str) -> str:
    parts = []
    rel = os.path.relpath(app_dir, root)
    if rel not in (".", ""):
        parts.append(f"cd {rel}")
    if not os.path.isdir(os.path.join(app_dir, "node_modules")):
        parts.append(f"{pm} install")
    parts.append(f"{pm} run {script}")
    return " && ".join(parts)


def heuristic(cwd: str) -> "str | None":
    """A confident start chain, or None when the project is ambiguous."""
    # 1) the root is itself a runnable app
    s = _dev_script(_scripts(cwd))
    if s:
        return _chain(cwd, cwd, _pm(cwd), s)

    # 2) exactly one obvious app subdir (else: ambiguous → let Claude decide)
    candidates: list = []

    def consider(d: str):
        ds = _dev_script(_scripts(d))
        if ds:
            candidates.append((d, ds))

    for name in _SUBDIRS:
        consider(os.path.join(cwd, name))
    for parent in _GLOBS:
        p = os.path.join(cwd, parent)
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                consider(os.path.join(p, name))

    if len(candidates) == 1:
        d, ds = candidates[0]
        own_lock = any(os.path.exists(os.path.join(d, f)) for f, _ in _PMS)
        return _chain(cwd, d, _pm(d) if own_lock else _pm(cwd), ds)
    return None


_PROMPT = (
    # Tagged so this throwaway generator session is kept out of the unified
    # session list (native.scan skips transcripts starting with the tag).
    native.INTERNAL_ONESHOT_TAG + "\n"
    "You are configuring a one-click 'preview' button for this project. Determine the "
    "exact shell command(s) to start its development web server so it can be opened in a "
    "browser. The command runs from this directory with a shell; chain steps with && "
    "(cd into the app subdir if needed, run install ONLY if dependencies are missing, then "
    "the dev server). Prefer the project's package manager (pnpm/yarn/bun/npm per its "
    "lockfile). Respond with ONLY a compact JSON object, no markdown and no prose:\n"
    '{"command": "<shell chain>", "explanation": "<one short sentence>"}'
)
_JSON_RE = re.compile(r"\{.*\}", re.S)


def _claude(cwd: str, chat_id: int) -> "dict | None":
    from bridge import aifeatures, runner  # late: runner → devserver is a cycle
    # Nothing was pressed to get here — opening a tab is enough — so this asks
    # first. Off, detect() falls through to its plain guess.
    if not aifeatures.enabled("preview"):
        return None
    result, _sid, _cost, is_error = runner.run_blocking(chat_id, _PROMPT, cwd=cwd, timeout=150)
    if is_error or not result:
        return None
    m = _JSON_RE.search(result)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except ValueError:
        return None
    cmd = (d.get("command") or "").strip()
    if not cmd:
        return None
    return {"command": cmd, "explanation": (d.get("explanation") or "").strip(), "source": "claude"}


def detect(cwd: str, chat_id: int) -> dict:
    """Hybrid detect → {command, source, explanation}. Always returns a dict."""
    h = heuristic(cwd)
    if h:
        return {"command": h, "source": "heuristic", "explanation": ""}
    c = _claude(cwd, chat_id)
    if c:
        return c
    return {"command": f"{_pm(cwd)} run dev", "source": "fallback",
            "explanation": "Could not detect the start command — using a default; edit if needed."}
