"""Profiles: which agent and account run a session, and with what settings.

A profile is a named, server-side bundle (agent, account, model, permission
mode, effort, tool switches) that a session is *bound* to (sessions.profile_id)
rather than stamped from. Per knob, a value set by hand in that session wins,
then the profile's, then today's default (effective()). So editing a profile
reaches every session that uses it, from its next turn, except where that
session was set by hand.

save_pick() is the one writer of those hand-set values. It stores NULL for a
pick equal to the profile's. That way a client echoing the picker on every send
(both /run routes do) never pins a session, and picking the profile's value
again is how a knob goes back to following it.

Why a JSON file and not a table: a few rows, edited from one screen, read at
every turn start. It follows the project_config.py pattern: atomic replace,
beside the DB, git-ignored, re-read only when its mtime moves. A project's
default profile is a field in project_config.

What a profile is not: a credential store. A Claude account is an accounts.py
slot and an agent account lives in acp_agents; a profile only names one. This
replaces the dashboard's browser-only PROFILES card (lib/profiles.ts), whose
saved entries the dashboard imports here once.

Stdlib only.
"""

import json
import os
import threading
import uuid

from bridge import accounts, acp_agents, config, project_config, store

CLAUDE = "claude"
NAME_MAX = 32
ID_MAX = 64          # an agent's mode or effort id
_CLAUDE_ONLY = "Claude models run in a Claude profile"
# session column -> profile field, for the knobs a picker can hand-set
KNOBS = {"model": "model", "permission_mode": "mode", "effort": "effort"}

PATH = os.path.join(os.path.dirname(config.BRIDGE_DB), "profiles.json")
_lock = threading.RLock()
_cache: "tuple[tuple, list]" = ((), [])   # ((path, mtime_ns), rows)


def _load() -> list:
    global _cache
    try:
        key = (PATH, os.stat(PATH).st_mtime_ns)
    except OSError:
        return []
    if _cache[0] != key:
        try:
            with open(PATH, encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, ValueError):
            rows = []
        rows = [r for r in rows if isinstance(r, dict) and r.get("id")] \
            if isinstance(rows, list) else []
        _cache = (key, rows)
    return [dict(r) for r in _cache[1]]


def _save(rows: list) -> None:
    global _cache
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
    os.replace(tmp, PATH)
    # mtime can be jiffy-coarse: two saves in one tick would look unchanged.
    _cache = ((), [])


def all_profiles() -> list:
    with _lock:
        return _load()


def get(pid) -> "dict | None":
    if not pid:
        return None
    return next((p for p in all_profiles() if p["id"] == pid), None)


def claude_slot_usable(slot: int) -> bool:
    return any(a["slot"] == slot and not a.get("disabled")
               for a in accounts.list_accounts())


def _check_claude(account: str, model: str, mode: str, effort: str) -> None:
    # Lazy: the servers import this module, and these live in the Mini App's.
    from bridge.miniapp.server import normalize_model_effort, normalize_permission_mode
    if account and not (account.isdigit() and claude_slot_usable(int(account))):
        raise ValueError(f"no usable Claude account in slot {account!r}")
    ok, _, _ = normalize_model_effort(model, None)
    if not ok:
        raise ValueError(f"unknown model {model!r}")
    if mode and normalize_permission_mode(mode) is None:
        raise ValueError(f"unknown permission mode {mode!r}")
    if effort and effort not in config.MINIAPP_EFFORTS:
        raise ValueError(f"unknown effort {effort!r}")


def _check_agent(agent: str, account: str, model: str, mode: str, effort: str) -> None:
    """An agent's model and mode ids are its own (the pickers read them off its
    advertised options), so they're taken as given, except a Claude model
    (safety rule 4)."""
    if acp_agents.preset(agent) is None:
        raise ValueError(f"unknown agent {agent!r}")
    if account and (acp_agents.account(account) or {}).get("agent") != agent:
        raise ValueError(f"no {agent} account {account!r}")
    if acp_agents.is_claude_model(model):
        raise ValueError(_CLAUDE_ONLY)
    if len(mode) > ID_MAX or len(effort) > ID_MAX:
        raise ValueError(f"mode and effort must be at most {ID_MAX} characters")


def _clean(fields: dict, keep_id: "str | None" = None) -> dict:
    """A validated profile body; ValueError carries the message the UI shows."""
    name = str(fields.get("name") or "").strip()
    if not 1 <= len(name) <= NAME_MAX:
        raise ValueError(f"name must be 1-{NAME_MAX} characters")
    if any(p["name"] == name and p["id"] != keep_id for p in _load()):
        raise ValueError(f"a profile named {name!r} already exists")
    agent = str(fields.get("agent") or CLAUDE).strip()
    account = str(fields.get("account") or "").strip()
    model = str(fields.get("model") or "").strip()
    mode = str(fields.get("mode") or "").strip()
    effort = str(fields.get("effort") or "").strip()
    tools = fields.get("tools")
    if tools is not None and not (isinstance(tools, list)
                                  and all(isinstance(t, str) for t in tools)):
        raise ValueError("tools must be a list of deny rules or null")
    if agent == CLAUDE:
        _check_claude(account, model, mode, effort)
    else:
        _check_agent(agent, account, model, mode, effort)
    return {"name": name, "agent": agent, "account": account, "model": model,
            "mode": mode, "effort": effort, "tools": tools}


def create(fields: dict) -> dict:
    with _lock:
        p = {"id": "p_" + uuid.uuid4().hex[:8], **_clean(fields)}
        _save(_load() + [p])
        return p


def update(pid: str, fields: dict) -> dict:
    with _lock:
        rows = _load()
        i = next((i for i, p in enumerate(rows) if p["id"] == pid), None)
        if i is None:
            raise KeyError(pid)
        rows[i] = {"id": pid, **_clean({**rows[i], **fields}, keep_id=pid)}
        _save(rows)
        return rows[i]


def delete(pid: str) -> None:
    with _lock:
        rows = _load()
        p = next((r for r in rows if r["id"] == pid), None)
        if p is None:
            raise KeyError(pid)
        _save([r for r in rows if r["id"] != pid])
    store.unbind_profile(pid, p.get("model") or None, p.get("mode") or None,
                         p.get("effort") or None,
                         None if p.get("tools") is None else json.dumps(p["tools"]))
    project_config.drop_profile(pid)


def effective(session: "dict | None") -> dict:
    """What this session's next turn runs with, knob by knob."""
    s = session or {}
    p = get(s.get("profile_id")) or {}
    raw = s.get("disabled_tools")
    if raw is not None:
        tools = store.parse_str_list(raw)
    elif p.get("tools") is not None:
        tools = list(p["tools"])
    else:
        tools = None                      # the caller's default applies
    out = {"profile_id": p.get("id"), "agent": p.get("agent") or CLAUDE,
           "account": p.get("account") or "", "disabled_tools": tools,
           "overrides": []}
    for col, field in KNOBS.items():
        out[col] = s.get(col) or p.get(field) or None
        if p and s.get(col):
            out["overrides"].append(col)
    if p and raw is not None:
        out["overrides"].append("disabled_tools")
    return out


def tools_for(session: "dict | None") -> list:
    """The deny rules this session's next run uses."""
    t = effective(session)["disabled_tools"]
    return store.default_disabled_tools() if t is None else t


def brief(session: dict) -> dict:
    """The run-settings half of a session brief, defaults filled in, so both
    composers show what the next turn will actually run."""
    e = effective(session)
    mode = e["permission_mode"]
    if mode is None and e["agent"] == CLAUDE:
        mode = config.MINIAPP_PERMISSION_MODE
    return {"profile_id": e["profile_id"], "agent": e["agent"], "account": e["account"],
            "model": e["model"], "permission_mode": mode, "effort": e["effort"],
            "disabled_tools": tools_for(session), "overrides": e["overrides"]}


def save_pick(session: dict, field: str, value: "str | None") -> None:
    """Save a person's pick for one knob, keeping the profile live. Unbound, a
    blank model or mode keeps the old pick (no picker offers one), but a blank
    effort is Auto, a pick of its own, so it clears the column."""
    if field not in KNOBS:
        raise ValueError(field)
    p = get(session.get("profile_id"))
    if p is None:
        if value or field == "effort":
            store.set_session_field(session["id"], field, value or None)
        return
    follow = not value or value == (p.get(KNOBS[field]) or None)
    store.set_session_field(session["id"], field, None if follow else value)


def bind(session: dict, pid: "str | None") -> "tuple[dict, int]":
    """Bind (or with "" unbind) a session's profile. Binding clears the knobs
    set by hand so the new profile shows through; unbinding freezes what the
    old one gave, so nothing changes under a running conversation. Another
    agent only before the first turn: an agent can't read another's history."""
    pid = (pid or "").strip() or None
    new = get(pid)
    if pid and new is None:
        return {"error": "no such profile"}, 404
    eff = effective(session)
    new_agent = (new or {}).get("agent") or CLAUDE
    if eff["agent"] != new_agent and store.count_turns(session["id"]):
        return {"error": "This session already ran on another agent. Start a "
                         "new session with that profile."}, 409
    store.set_session_field(session["id"], "profile_id", pid)
    for col in KNOBS:
        store.set_session_field(session["id"], col, None if pid else eff[col])
    if pid is None and session.get("disabled_tools") is None \
            and eff["disabled_tools"] is not None:
        store.set_disabled_tools(session["id"], eff["disabled_tools"])
    return {"ok": True, "profile_id": pid}, 200


def project_default(project: str) -> "str | None":
    pid = project_config.profile(project)
    return pid if get(pid) else None


def set_project_default(project: str, pid: "str | None") -> None:
    if pid and not get(pid):
        raise ValueError("no such profile")
    project_config.set_profile(project, pid)


def claude_slot(eff: dict) -> "int | None":
    """A Claude profile's account as the slot start_streaming_job takes."""
    a = eff.get("account") or ""
    return int(a) if eff.get("agent") == CLAUDE and a.isdigit() else None


def refusal(eff: dict, chat_id) -> "str | None":
    """Why this session's bound profile can't run right now, or None. Never
    a silent fallback to another login (the ladder.resolve_agent rule). An
    agent profile answers acp_agents.run_problem: owner's chat only, installed,
    its account still there, no Claude model."""
    if eff["agent"] != CLAUDE:
        return acp_agents.run_problem(acp_agents.preset(eff["agent"]), eff["account"],
                                      chat_id, eff["model"])
    slot = claude_slot(eff)
    if slot is not None and not claude_slot_usable(slot):
        name = (get(eff.get("profile_id")) or {}).get("name") or "?"
        return (f"Profile {name!r} runs on Claude account {slot}, which is gone "
                f"or disabled. Edit the profile or pick another.")
    return None


def api_list() -> dict:
    return {"profiles": all_profiles(),
            "project_defaults": {k: v for k, v in project_config.profiles_by_project().items()
                                 if get(v)}}


def api_write(body: dict) -> "tuple[dict, int]":
    """POST …/profiles: {action: create|update|delete, id?, …fields}."""
    action = body.get("action")
    try:
        if action == "create":
            return {"ok": True, "profile": create(body)}, 200
        if action == "update":
            return {"ok": True, "profile": update(str(body.get("id") or ""), body)}, 200
        if action == "delete":
            delete(str(body.get("id") or ""))
            return {"ok": True}, 200
    except KeyError:
        return {"error": "no such profile"}, 404
    except ValueError as e:
        return {"error": str(e)}, 400
    return {"error": "action must be create, update or delete"}, 400


def agent_for(session: "dict | None", profile_id=None, project=None) -> str:
    """The agent a run or a pick is for: the session's, else the one a fresh
    session would be bound to (that profile_id, else the project's default,
    as runner._resolve_session binds it), else Claude."""
    if session:
        return effective(session)["agent"]
    p = get(profile_id) or get(project_default(project))
    return (p or {}).get("agent") or CLAUDE


def run_values(model, mode, effort, agent=CLAUDE) -> tuple:
    """Validate a run's or a pick's model/mode/effort for the agent it runs on.
    Returns (error or None, model, mode, effort); blanks become None. Claude's
    go through the Mini App's normalizers. Another agent's ids are its own and
    pass as given, except a Claude model (safety rule 4); unknown ones are a
    log row in the turn (acp.Turn.apply)."""
    if agent != CLAUDE:
        m, p, e = (str(v or "").strip() or None for v in (model, mode, effort))
        if acp_agents.is_claude_model(m):
            return _CLAUDE_ONLY, None, None, None
        if len(p or "") > ID_MAX or len(e or "") > ID_MAX:
            return f"mode and effort must be at most {ID_MAX} characters", None, None, None
        return None, m, p, e
    from bridge.miniapp.server import normalize_model_effort, normalize_permission_mode
    ok, m, e = normalize_model_effort(model, effort)
    if not ok:
        return "invalid model", None, None, None
    p = normalize_permission_mode(mode)
    if (mode or "").strip() and p is None:
        return "invalid permission_mode", None, None, None
    return None, m, p, e
