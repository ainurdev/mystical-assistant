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
GIT_TIMEOUT = 10        # short git operations (rev-parse, status)

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
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        v = data.get("built_at_commit")
        return str(v) if v else None
    except (OSError, ValueError):
        log.debug("graphmap built_commit read failed", exc_info=True)
        return None


def _head_commit(cwd: str) -> "str | None":
    try:
        proc = subprocess.run(["git", "rev-parse", "--short=8", "HEAD"], cwd=cwd,
                              capture_output=True, text=True, timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        log.debug("graphmap head_commit read failed", exc_info=True)
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
        log.debug("graphify explain timed out", exc_info=True)
        return "graphify explain timed out."
    except OSError as e:
        log.debug("graphify explain OSError", exc_info=True)
        return f"graphify explain failed: {e}"
    out = (proc.stdout or proc.stderr or "").strip()
    if len(out) > EXPLAIN_MAX_CHARS:
        out = out[:EXPLAIN_MAX_CHARS] + "\n…(truncated)"
    return out or "(no output)"


def _exclude_artifacts(cwd: str) -> None:
    """Keep artifacts out of the user's repo: append graphify-out/ to
    .git/info/exclude (repo-local, never committed). Best-effort."""
    try:
        info = os.path.join(cwd, ".git", "info")
        if not os.path.isdir(info):
            return
        path = os.path.join(info, "exclude")
        try:
            with open(path, encoding="utf-8") as f:
                if "graphify-out/" in f.read():
                    return
        except OSError:
            pass
        with open(path, "a", encoding="utf-8") as f:
            f.write("\ngraphify-out/\n")
    except OSError:
        log.debug("graphmap exclude_artifacts failed", exc_info=True)


def update(cwd: str, timeout: int = BUILD_TIMEOUT) -> "tuple[bool, str]":
    """Build or refresh a project's graph (`graphify update .`). Serialized per
    project; a concurrent caller returns immediately instead of stacking."""
    bin_ = graphify_bin()
    if not bin_:
        return False, "graphify is not installed (pipx install graphifyy)."
    lock = _lock_for(cwd)
    if not lock.acquire(blocking=False):
        return False, "already building"
    key = os.path.realpath(cwd)
    _building.add(key)
    try:
        first = not has_graph(cwd)
        proc = subprocess.run([bin_, "update", "."], cwd=cwd,
                              capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-500:]
            return False, f"graphify update failed: {tail or proc.returncode}"
        if first:
            _exclude_artifacts(cwd)
        return True, "graph updated"
    except subprocess.TimeoutExpired:
        log.debug("graphmap update timed out", exc_info=True)
        return False, f"graphify update timed out after {timeout}s"
    except OSError as e:
        log.debug("graphmap update OSError", exc_info=True)
        return False, f"graphify update failed: {e}"
    finally:
        _building.discard(key)
        lock.release()


def update_async(cwd: str, timeout: int = BUILD_TIMEOUT) -> dict:
    """Kick off a build/refresh in a daemon thread and return the current state.
    HTTP handlers use this so long builds never hold a request (tunnel-safe);
    clients poll graph_state's `building` flag."""
    threading.Thread(target=update, args=(cwd, timeout), daemon=True).start()
    return graph_state(cwd)


def refresh_async(cwd: "str | None") -> None:
    """Post-turn refresh for projects that already have a graph. Fire-and-forget;
    the per-project lock drops overlapping refreshes. Never blocks a turn."""
    if not cwd or not has_graph(cwd) or not graphify_bin():
        return
    threading.Thread(target=update, args=(cwd, REFRESH_TIMEOUT),
                     daemon=True).start()


# --- graph pack (system-prompt structure summary) ----------------------------
# Injected by runner._compose_system_prompt. MUST stay byte-identical across
# turns until graph.json changes on disk (Claude Code prompt cache), so it
# contains no commit hashes or timestamps — structure only.

PACK_TOKEN_BUDGET = 400
PACK_COMMUNITIES = 8
PACK_HUBS = 6

_pack_cache: "dict[str, tuple[float, str]]" = {}


def _estimate_tokens(text: str) -> int:
    """Same deterministic ~4-chars/token estimate as bridge.memory."""
    return (len(text) + 3) // 4


def _render_pack(data: dict, labels: dict) -> str:
    nodes = data.get("nodes") or []
    links = data.get("links") or []
    if not nodes:
        return ""
    degree: dict = {}
    for e in links:
        for end in ("source", "target"):
            nid = e.get(end)
            if nid is not None:
                degree[nid] = degree.get(nid, 0) + 1
    by_comm: dict = {}
    for n in nodes:
        by_comm.setdefault(n.get("community"), []).append(n)
    ranked = sorted(by_comm.items(), key=lambda kv: -len(kv[1]))
    comm_lines = []
    for cid, members in ranked[:PACK_COMMUNITIES]:
        label = labels.get(str(cid)) or f"community {cid}"
        hubs = sorted(members, key=lambda n: -degree.get(n.get("id"), 0))[:3]
        names = ", ".join(str(h.get("label", "?")) for h in hubs)
        comm_lines.append(f"- {label} ({len(members)} nodes): {names}")
    files = [n for n in nodes if (n.get("metadata") or {}).get("kind") == "file"]
    top = sorted(files, key=lambda n: -degree.get(n.get("id"), 0))[:PACK_HUBS]
    hub_line = ", ".join(str(n.get("label")) for n in top)

    head = ["# Project map (graphify; auto-generated structure)", "Subsystems:"]
    tail = ["Structure questions: run `graphify explain \"<thing>\"` in the "
            "project root (or use the dashboard MAP tab)."]
    lines = comm_lines + ([f"Hub files: {hub_line}"] if hub_line else [])
    while lines:
        text = "\n".join(head + lines + tail)
        if _estimate_tokens(text) <= PACK_TOKEN_BUDGET:
            return text
        lines.pop()
    return ""


def graph_pack(cwd: "str | None") -> str:
    """≤~400-token structure summary for the system prompt; "" when the project
    has no graph. Memoized by graph.json mtime so repeat turns get the exact
    same string (cache-eligible) without re-parsing megabytes of JSON."""
    if not cwd:
        return ""
    path = _graph_json(cwd)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return ""
    key = os.path.realpath(cwd)
    cached = _pack_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    labels: dict = {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return ""
        try:
            with open(os.path.join(cwd, OUT_DIR, ".graphify_labels.json"),
                      encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                labels = loaded
        except (OSError, ValueError):
            pass
        text = _render_pack(data, labels)
    except (OSError, ValueError):
        log.debug("graphmap graph_pack failed", exc_info=True)
        return ""
    _pack_cache[key] = (mtime, text)
    return text
