"""Project memory: retrieval + Context Pack rendering (this module also hosts the
post-turn capture extractor). Curated, project+branch-scoped semantic memory.
See docs/superpowers/specs/2026-07-01-project-memory-design.md
"""

import json
import logging
import re

from bridge import config, store

log = logging.getLogger("bridge.memory")

_TYPES = {"convention", "decision", "preference", "goal", "gotcha"}
_SCOPES = {"user", "project"}
_MAX_OPS = 2

# How load-bearing each type is for a fresh session (lower = earlier in the pack).
_TYPE_ORDER = {"goal": 0, "preference": 1, "gotcha": 2, "decision": 3, "convention": 4}


def _estimate_tokens(text: str) -> int:
    """Deterministic, offline ~4-chars/token estimate (no network on the hot path)."""
    return (len(text) + 3) // 4


# --- retrieval --------------------------------------------------------------

def retrieve(owner_id: int, project: str, branch: "str | None",
             prompt: "str | None" = None) -> list[dict]:
    """Active memories a session should see. `prompt` is reserved for semantic
    top-K (Approach B); today ordering is pinned/recency via the store."""
    return store.resolve_memories(owner_id, project, branch)


# --- Context Pack -----------------------------------------------------------

def _line(m: dict) -> str:
    return f"- ({m['type']}) {m['title']} — {m['body']}"


def _build_pack(mems: list[dict]) -> str:
    if not mems:
        return ""
    # Tiers 1-2 (user prefs + active goals) are always kept; the rest fill a budget.
    always, budgeted = [], []
    for m in mems:
        (always if (m["scope"] == "user" or m["type"] == "goal") else budgeted).append(m)
    # Stable sort keeps the store's pinned-then-newest order as the tiebreaker.
    budgeted.sort(key=lambda m: (0 if m["pinned"] else 1, _TYPE_ORDER.get(m["type"], 9)))
    lines = [_line(m) for m in always]
    used = _estimate_tokens("\n".join(lines))
    for m in budgeted:
        ln = _line(m)
        used += _estimate_tokens(ln) + 1
        if used > config.MEMORY_TOKEN_BUDGET:
            break
        lines.append(ln)
    return "# Project memory (curated; editable via the Memory view)\n" + "\n".join(lines)


# Memoized by namespace_version so the string is byte-identical across turns until
# memory changes — keeps it inside Claude Code's prompt cache (see §4 of the spec).
_pack_cache: dict = {}


def render_pack(owner_id: int, project: str, branch: "str | None") -> str:
    version = store.namespace_version(owner_id, project, branch)
    key = (owner_id, project, branch)
    cached = _pack_cache.get(key)
    if cached and cached[0] == version:
        return cached[1]
    text = _build_pack(retrieve(owner_id, project, branch))
    _pack_cache[key] = (version, text)
    return text


# --- capture (post-turn extractor) ------------------------------------------
# Machine gate: a cheap Haiku pass reconciles proposed facts against existing
# ones (ADD/UPDATE/SKIP) and emits Keep/Skip candidates — the human gate.

def _parse_ops(raw: str) -> list[dict]:
    """Parse the model's strict-JSON reply into validated ADD/UPDATE ops. Tolerant
    of ```json fences / prose; returns [] on anything malformed (never raises)."""
    try:
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        m = re.search(r"\[.*\]", raw, re.S)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            return []
    if not isinstance(data, list):
        return []
    ops: list[dict] = []
    for it in data:
        if not isinstance(it, dict):
            continue
        op = str(it.get("op", "")).upper()
        if op not in ("ADD", "UPDATE"):          # SKIP (and anything else) drops out
            continue
        t, sc = str(it.get("type", "")), str(it.get("scope", ""))
        title, body = str(it.get("title", "")).strip(), str(it.get("body", "")).strip()
        if t not in _TYPES or sc not in _SCOPES or not title or not body:
            continue
        ops.append({"op": op, "id": it.get("id"), "type": t, "scope": sc,
                    "title": title, "body": body})
        if len(ops) >= _MAX_OPS:
            break
    return ops


def _existing(owner_id: int, project: str, branch: "str | None") -> list[dict]:
    """Memories the capture pass reconciles against: the active cascade plus any
    still-pending candidates (so it doesn't re-propose what's already queued)."""
    rows = store.resolve_memories(owner_id, project, branch)
    rows += store.list_memories(owner_id, scope="project", project=project, status="candidate")
    rows += store.list_memories(owner_id, scope="user", status="candidate")
    return list({r["id"]: r for r in rows}.values())


def _build_capture_prompt(existing: list[dict], assistant_text: str,
                          edited_files: list[str]) -> str:
    known = "\n".join(f"- [{m['id']}] ({m['type']}) {m['title']}" for m in existing) or "(none)"
    files = ", ".join(edited_files) if edited_files else "(none)"
    return (
        "You maintain a curated project memory. From the assistant turn below, "
        "propose at most 2 durable facts worth remembering for future sessions: a "
        "convention, a decision (with the why), the user's cross-project preference, "
        "an active goal, or a gotcha. Reconcile against the KNOWN memories: if a fact "
        "is already known, use op SKIP; if it updates or contradicts one, use op "
        "UPDATE with that memory's id; otherwise op ADD.\n\n"
        "Return STRICT JSON only — an array of "
        '{op:"ADD"|"UPDATE"|"SKIP", id?, '
        'type:"convention|decision|preference|goal|gotcha", scope:"user|project", '
        "title, body}. Use scope \"user\" only for the user's cross-project "
        "preferences. Keep title and body terse (one line each). Return [] if nothing "
        f"is worth keeping.\n\nKNOWN memories:\n{known}\n\nEdited files: {files}\n\n"
        f"Assistant turn:\n{assistant_text[:4000]}")


def _default_run(owner_id: int, prompt: str) -> str:
    """Real capture call: a cheap, sessionless Haiku pass with NO Context Pack
    (skip_pack) so memory never biases its own extraction."""
    from bridge import native, runner  # lazy: avoid an import cycle
    return runner.run_blocking(
        owner_id, native.INTERNAL_ONESHOT_TAG + "\n" + prompt,
        model="haiku", skip_pack=True)[0]


def propose(owner_id: int, session_id: str, turn_id: str, project: str,
            branch: "str | None", assistant_text: str, edited_files: list[str], *,
            run=None, auto: bool = False) -> list[str]:
    """Reconcile durable facts from a finished turn into Keep/Skip candidates.
    Best-effort and swallowed on any failure — never blocks or errors the turn.
    Returns the ids of the candidates it created."""
    if not config.MEMORY_ENABLE or not (assistant_text or "").strip():
        return []
    run = run or (lambda p: _default_run(owner_id, p))
    existing = _existing(owner_id, project, branch)
    try:
        ops = _parse_ops(run(_build_capture_prompt(existing, assistant_text, edited_files)) or "")
    except Exception:  # noqa: BLE001
        log.debug("memory capture failed", exc_info=True)
        return []
    existing_ids = {r["id"] for r in existing}
    created: list[str] = []
    for op in ops:
        t, scope = op["type"], op["scope"]
        if scope == "user":
            proj, br = None, None
        else:                                    # goals are branch-scoped; other facts repo-wide
            proj, br = project, (branch if t == "goal" else None)
        sup = op["id"] if (op["op"] == "UPDATE" and op.get("id") in existing_ids) else None
        m = store.add_memory(owner_id, scope, t, op["title"], op["body"],
                             project_path=proj, branch=br,
                             status="active" if auto else "candidate",
                             source_session_id=session_id, source_turn_id=turn_id,
                             supersedes_id=sup)
        if auto and sup:                         # no human gate → archive the target now
            store.set_memory_status(sup, "archived")
        store.append_event(session_id, turn_id, {
            "type": "memory_candidate", "item_id": m["id"], "mem_type": t,
            "scope": scope, "title": op["title"], "body": op["body"]})
        created.append(m["id"])
    return created


# --- action layer (shared by both HTTP servers; owner-scoped) ---------------

def _owned(owner_id: int, item_id: str) -> "dict | None":
    m = store.get_memory(item_id)
    return m if (m and m["owner_id"] == owner_id) else None


def keep_or_skip(owner_id: int, item_id: str, action: str) -> "dict | None":
    """Keep activates a candidate (and archives its UPDATE target); Skip archives
    it. Returns the updated row, or None if it isn't the owner's."""
    m = _owned(owner_id, item_id)
    if not m:
        return None
    if action == "keep":
        if m.get("supersedes_id"):
            store.set_memory_status(m["supersedes_id"], "archived")
        store.set_memory_status(item_id, "active")
    else:
        store.set_memory_status(item_id, "archived")
    return store.get_memory(item_id)


def set_status(owner_id: int, item_id: str, status: str) -> "dict | None":
    if not _owned(owner_id, item_id):
        return None
    store.set_memory_status(item_id, status)
    return store.get_memory(item_id)


def set_pin(owner_id: int, item_id: str, pinned: bool) -> "dict | None":
    if not _owned(owner_id, item_id):
        return None
    store.set_pinned(item_id, bool(pinned))
    return store.get_memory(item_id)


def edit(owner_id: int, item_id: str, title: "str | None", body: "str | None") -> "dict | None":
    if not _owned(owner_id, item_id):
        return None
    store.update_memory(item_id, title=title, body=body)
    return store.get_memory(item_id)


def items(owner_id: int, project: "str | None" = None, branch: "str | None" = None,
          status: str = "active") -> list[dict]:
    return store.list_memories(owner_id, project=project, branch=branch, status=status)
