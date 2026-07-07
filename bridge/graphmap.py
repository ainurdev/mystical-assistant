"""Graphify integration: per-project code knowledge graphs (graphify-out/).

Shells out to the graphify CLI (pipx `graphifyy`; tree-sitter AST, no LLM for
code) and serves/parses its artifacts. Postures mirror the rest of the bridge:
binary resolution like runner.claude_bin(), best-effort like memory.py —
failures yield empty/friendly values and never block a turn.
See docs/superpowers/specs/2026-07-07-graphify-ponytail-features-design.md
"""

import json
import logging
import os
import shutil
import subprocess
import threading

log = logging.getLogger("bridge.graphmap")

OUT_DIR = "graphify-out"
BUILD_TIMEOUT = 300     # explicit build/refresh (first build = full AST pass)
REFRESH_TIMEOUT = 120   # post-turn refresh (warm cache)
EXPLAIN_TIMEOUT = 30
EXPLAIN_MAX_CHARS = 3500

_GRAPHIFY_FALLBACKS = ("~/.local/bin/graphify",)   # pipx/uv tool bin dir
_graphify_bin: "str | None" = None


def graphify_bin() -> "str | None":
    """Absolute path to graphify, or None when not installed. Re-resolves when
    the cached path disappears; keeps returning None until installed (cheap)."""
    global _graphify_bin
    if _graphify_bin and os.path.exists(_graphify_bin):
        return _graphify_bin
    found = shutil.which("graphify")
    if not found:
        for cand in _GRAPHIFY_FALLBACKS:
            cand = os.path.expanduser(cand)
            if os.access(cand, os.X_OK):
                found = cand
                break
    _graphify_bin = found
    return _graphify_bin


def _graph_json(cwd: str) -> str:
    return os.path.join(cwd, OUT_DIR, "graph.json")


def has_graph(cwd: str) -> bool:
    return os.path.isfile(_graph_json(cwd))


def _built_commit(cwd: str) -> "str | None":
    try:
        with open(_graph_json(cwd), encoding="utf-8") as f:
            v = json.load(f).get("built_at_commit")
        return str(v) if v else None
    except (OSError, ValueError):
        return None


def _head_commit(cwd: str) -> "str | None":
    try:
        proc = subprocess.run(["git", "rev-parse", "--short=8", "HEAD"], cwd=cwd,
                              capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return (proc.stdout.strip() or None) if proc.returncode == 0 else None


# One build at a time per project; `_building` backs the UI's polling flag.
_build_locks: "dict[str, threading.Lock]" = {}
_locks_guard = threading.Lock()
_building: "set[str]" = set()


def _lock_for(cwd: str) -> threading.Lock:
    with _locks_guard:
        return _build_locks.setdefault(os.path.realpath(cwd), threading.Lock())


def graph_state(cwd: str) -> dict:
    built = _built_commit(cwd)
    head = _head_commit(cwd)
    return {
        "available": graphify_bin() is not None,
        "exists": has_graph(cwd),
        "built_commit": built,
        "head": head,
        # short-sha lengths may drift between tools; prefix-compare both ways
        "stale": bool(built and head
                      and not (head.startswith(built) or built.startswith(head))),
        "building": os.path.realpath(cwd) in _building,
    }


def explain(cwd: str, query: str) -> str:
    """`graphify explain "<query>"` in the project root, truncated for chat."""
    bin_ = graphify_bin()
    if not bin_:
        return "graphify is not installed (pipx install graphifyy)."
    if not has_graph(cwd):
        return "No graph yet — build one first (MAP tab / /map build)."
    try:
        proc = subprocess.run([bin_, "explain", query], cwd=cwd,
                              capture_output=True, text=True,
                              timeout=EXPLAIN_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "graphify explain timed out."
    except OSError as e:
        return f"graphify explain failed: {e}"
    out = (proc.stdout or proc.stderr or "").strip()
    if len(out) > EXPLAIN_MAX_CHARS:
        out = out[:EXPLAIN_MAX_CHARS] + "\n…(truncated)"
    return out or "(no output)"
