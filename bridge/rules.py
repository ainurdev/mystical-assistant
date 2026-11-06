"""Rules: "when X, do Y" for any agent, without writing a hook script.

Hooks are the strongest lever an agent harness has: a hook can block a call, add context or
keep the agent working. But a hook is a shell command in a config file. A rule is what you
meant: protect these paths, don't let a force push through, don't finish without testing.

Rules live here and are evaluated in the bridge, so they read the same for every provider,
are logged, and show in the transcript when they fire. Each agent only gets a thin dispatcher
(bridge/hook_dispatch.py) that posts the event and acts on the answer.

  - Claude: per run through --settings, as the push check and ask check already are, so no
    file of yours changes and a terminal `claude` is untouched.
  - Kimi Code: hooks live only in the user-level config.toml. One managed block there runs the
    dispatcher, and it does nothing unless a Mystical run set its token, so a terminal
    `kimi` behaves as before. It's written only once a rule that needs it is on, and
    taken out again when none are. Only UserPromptSubmit, PreToolUse and Stop can block
    there, so a rule's `agents` says what it can do on each.

Everything is off by default except the ones marked `on`: blocking changes how agents behave,
so it's your call. A dispatcher that can't reach the bridge lets the action through: a rule
must never be the reason work stops when the bridge restarts.

Stop rules ask once per turn, so an agent can't be held in a loop.

Stdlib only.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time

from bridge import store

_FILE = os.path.expanduser(os.environ.get("RULES_FILE", "~/.mystical/rules.json"))
_lock = threading.Lock()
_log: list = []
_LOG_MAX = 200
_stop_asked: set = set()       # turn ids already nudged by a Stop rule
_subagents: dict = {}          # session id -> {name: {started, ended}} from Subagent hooks

_DESTRUCTIVE = (r"git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+push\s+[^|;&]*(--force|-f\b)|"
                r"git\s+checkout\s+--\s|git\s+branch\s+-D|git\s+rebase\b|rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|"
                r"drop\s+(table|database)|mkfs\.|dd\s+if=")
_TEST_CMD = re.compile(r"\b(pytest|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|vitest|jest|go\s+test|cargo\s+test|"
                       r"phpunit|rspec|make\s+test|tsc\b|\.check\.ts)", re.I)
_SECRET_OUT = re.compile(r"(sk-ant-[A-Za-z0-9_.-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|"
                         r"xox[abposr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)")
BOTH, CLAUDE_ONLY = ("claude", "kimi"), ("claude",)
_CODE_EDIT = ("Edit", "Write", "NotebookEdit", "MultiEdit")

# id, group, what the page says, on by default, which agents, hook events it needs.
CATALOG = (
    {"id": "destructive", "group": "Safety", "name": "Stop destructive commands",
     "about": "Blocks git reset --hard, force pushes, rm -rf, dropping tables and the like, with the reason sent to the "
              "agent. It can ask you to run it, or you can switch this off.",
     "on": False, "agents": BOTH, "events": ("PreToolUse",), "fields": {"mode": "block"}},
    {"id": "protect_paths", "group": "Safety", "name": "Protect paths",
     "about": "Edits and shell commands touching these paths are blocked.",
     "on": False, "agents": BOTH, "events": ("PreToolUse",), "fields": {"paths": [".env", "*.pem", "migrations/"]}},
    {"id": "mask_secrets", "group": "Safety", "name": "Hide secrets in tool output",
     "about": "Keys and tokens in what a tool returned are blanked before the model reads them. Claude can do this; "
              "Kimi can't replace a tool's output.",
     "on": False, "agents": CLAUDE_ONLY, "events": ("PostToolUse",), "fields": {}},
    {"id": "test_before_done", "group": "Quality", "name": "Don't finish untested",
     "about": "If code changed this turn and nothing ran the tests, the agent is told once to run them or say why not.",
     "on": False, "agents": BOTH, "events": ("Stop",), "fields": {}},
    {"id": "format_on_edit", "group": "Quality", "name": "Format after edits",
     "about": "Runs the project's formatter on a file after an agent edits it.",
     "on": False, "agents": BOTH, "events": ("PostToolUse",), "fields": {}},
    {"id": "pack_after_compact", "group": "Context", "name": "Instructions back after compaction",
     "about": "When an agent compacts its context, Mystical's instructions go in again on its next turn. Claude keeps "
              "them in its system prompt already, so this is for agents.",
     "on": True, "agents": ("kimi",), "events": ("PostCompact",), "fields": {}},
    {"id": "prompt_context", "group": "Context", "name": "Branch and task on each prompt",
     "about": "Adds the current branch and its Rivendell task key to each prompt.",
     "on": False, "agents": BOTH, "events": ("UserPromptSubmit",), "fields": {}},
    {"id": "subagent_tracking", "group": "Visibility", "name": "Live subagent status",
     "about": "Subagents' start and stop reach the sidebar as they happen, including Kimi's own, which otherwise read "
              "\"no details available\".",
     "on": True, "agents": BOTH, "events": ("SubagentStart", "SubagentStop"), "fields": {}},
    {"id": "ping_on_failure", "group": "Visibility", "name": "Ping me on repeated failures",
     "about": "Sends a notification when a tool has failed this many times in a row.",
     "on": False, "agents": BOTH, "events": ("PostToolUseFailure",), "fields": {"times": 5}},
)
_BY_ID = {r["id"]: r for r in CATALOG}
_failures: dict = {}


def _load() -> dict:
    try:
        with open(_FILE, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    os.makedirs(os.path.dirname(_FILE), mode=0o700, exist_ok=True)
    with open(_FILE + ".tmp", "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    os.replace(_FILE + ".tmp", _FILE)


def _picks(project: "str | None", session: "dict | None") -> "list[dict]":
    """Nearest level first."""
    d = _load()
    chat = store.parse_json((session or {}).get("chat_config")).get("_rules") or {}
    return [chat, (d.get("projects") or {}).get(project or "") or {}, d.get("machine") or {}]


def state_of(rule_id: str, project: "str | None", session: "dict | None") -> dict:
    """{on, level, fields} after the levels: a level's pick is per rule."""
    r = _BY_ID[rule_id]
    fields = dict(r["fields"])
    for pick, level in zip(_picks(project, session), ("chat", "project", "machine")):
        if rule_id in pick:
            fields.update(pick[rule_id].get("fields") or {})
            return {"on": bool(pick[rule_id].get("on")), "level": level, "fields": fields}
    return {"on": r["on"], "level": None, "fields": fields}


def listing(project: "str | None", session: "dict | None") -> list:
    return [{**{k: r[k] for k in ("id", "group", "name", "about")}, "agents": list(r["agents"]),
             **state_of(r["id"], project, session)} for r in CATALOG]


def set_rule(level: str, rule_id: str, on: "bool | None", fields: "dict | None", project: "str | None",
             session: "dict | None") -> None:
    """A level's pick for a rule; on=None clears it, so the next level decides."""
    if rule_id not in _BY_ID:
        raise ValueError("No such rule.")
    row = {"on": bool(on), "fields": _clean_fields(rule_id, fields or {})}
    if level == "chat":
        if not session:
            raise ValueError("That needs a chat.")
        cfg = store.parse_json(session.get("chat_config"))
        rules = cfg.setdefault("_rules", {})
        rules.pop(rule_id, None) if on is None else rules.__setitem__(rule_id, row)
        store.set_session_field(session["id"], "chat_config", json.dumps(cfg))
        if on:
            # Kimi's hooks are per login, so its block has to carry this event for one chat
            # to use it. The bridge still decides per chat when the event arrives.
            with _lock:
                d = _load()
                d.setdefault("chat_used", {})[rule_id] = True
                _save(d)
    else:
        if level not in ("machine", "project") or (level == "project" and not project):
            raise ValueError("Pick a level, and a project for that level.")
        with _lock:
            d = _load()
            picks = d.setdefault("machine", {}) if level == "machine" else d.setdefault("projects", {}).setdefault(project, {})
            picks.pop(rule_id, None) if on is None else picks.__setitem__(rule_id, row)
            _save(d)
    sync_agents()


def _clean_fields(rule_id: str, f: dict) -> dict:
    out = {}
    if "paths" in f:
        out["paths"] = [str(p).strip() for p in f["paths"] if str(p).strip()][:50]
    if "mode" in f and f["mode"] in ("block", "ask"):
        out["mode"] = f["mode"]
    if "times" in f:
        out["times"] = max(1, min(int(f["times"]), 100))
    return out


# ------- evaluating -----------------------------------------------------------------

def _text_of(tool_input) -> str:
    if isinstance(tool_input, dict):
        return " ".join(str(v) for v in tool_input.values() if isinstance(v, (str, int)))
    return str(tool_input or "")


def _path_hit(text: str, patterns: list) -> "str | None":
    for p in patterns:
        rx = re.escape(p).replace(r"\*", r"[^\s/]*")
        # "migrations/" names a folder, so what follows it is inside it.
        tail = "" if p.endswith("/") else r"($|[\s/\"'])"
        if re.search(rf"(^|[\s/\"'=]){rx}{tail}", text):
            return p
    return None


def _note(session: dict, rule: str, event: str, tool: str, decision: str, why: str) -> None:
    from bridge import runner
    row = {"at": time.time(), "session": session["id"], "rule": rule, "event": event, "tool": tool,
           "decision": decision, "why": why[:400]}
    with _lock:
        _log.append(row)
        del _log[:-_LOG_MAX]
    job = runner.live_job(session["id"])
    if job is not None:
        job.add({"type": "rule", "rule": _BY_ID[rule]["name"], "decision": decision, "tool": tool, "why": why[:400]})


def recent(session_id: "str | None" = None, limit: int = 100) -> list:
    with _lock:
        rows = [r for r in _log if not session_id or r["session"] == session_id]
    return rows[-limit:][::-1]


def evaluate(session: dict, event: str, payload: dict) -> dict:
    """The hook's answer: {} to let it be, else what hook_dispatch should do:
    {block: reason} | {ask: reason} | {context: text} | {output: replaced} | {keep_going: reason}"""
    from bridge import profiles
    project, agent = session.get("project"), profiles.effective(session)["agent"]
    on = lambda rid: state_of(rid, project, session)  # noqa: E731
    tool = str(payload.get("tool_name") or "")
    tin = payload.get("tool_input") or {}
    usable = lambda rid: agent in _BY_ID[rid]["agents"] and on(rid)["on"]  # noqa: E731
    if event == "PreToolUse":
        text = _text_of(tin)
        if tool in ("Bash", "Shell", "shell") and usable("destructive") and re.search(_DESTRUCTIVE, text, re.I):
            why = "This command is destructive and a rule stops it here. Ask the user to run it, or find another way."
            mode = on("destructive")["fields"].get("mode", "block")
            if mode == "ask" and agent == "claude":
                _note(session, "destructive", event, tool, "ask", text[:200])
                return {"ask": why}
            _note(session, "destructive", event, tool, "blocked", text[:200])
            return {"block": why}
        if usable("protect_paths"):
            hit = _path_hit(text, on("protect_paths")["fields"].get("paths") or [])
            if hit and (tool in _CODE_EDIT or tool in ("Bash", "Shell", "shell")):
                _note(session, "protect_paths", event, tool, "blocked", hit)
                return {"block": f"{hit} is protected by a rule. Ask the user if this really has to change."}
    elif event == "PostToolUse":
        out = {}
        if usable("format_on_edit") and tool in _CODE_EDIT:
            _format(session, tin)
        if usable("mask_secrets"):
            result = payload.get("tool_response")
            raw = result if isinstance(result, str) else json.dumps(result) if result is not None else ""
            if _SECRET_OUT.search(raw):
                _note(session, "mask_secrets", event, tool, "hid a secret", tool)
                out["output"] = _SECRET_OUT.sub("***", raw)
        _failures.pop(session["id"], None)
        return out
    elif event == "PostToolUseFailure":
        n = _failures[session["id"]] = _failures.get(session["id"], 0) + 1
        if usable("ping_on_failure") and n == on("ping_on_failure")["fields"].get("times", 5):
            _ping(session, f"{n} tools in a row failed")
            _note(session, "ping_on_failure", event, tool, "pinged", str(n))
    elif event == "Stop":
        return _on_stop(session, usable)
    elif event == "UserPromptSubmit" and usable("prompt_context"):
        from bridge import git, taskcheck
        cwd = session.get("work_cwd") or session.get("cwd") or ""
        br = git.current_branch_cached(cwd) if cwd else ""
        task = ""
        top = taskcheck.toplevel(cwd) if cwd else ""
        if top:
            task = str(taskcheck.read(top).get(taskcheck.slot(top, br)) or "")
        return {"context": f"Current branch: {br or 'unknown'}." + (f" Task: {task}." if task and task not in ("asked", "skip") else "")}
    elif event == "PostCompact" and usable("pack_after_compact"):
        cfg = store.parse_json(session.get("chat_config"))
        cfg["_pack_again"] = True
        store.set_session_field(session["id"], "chat_config", json.dumps(cfg))
        _note(session, "pack_after_compact", event, "", "instructions go in again next turn", "")
    elif event in ("SubagentStart", "SubagentStop") and usable("subagent_tracking"):
        name = str(payload.get("agent_name") or payload.get("agent_type") or payload.get("agent_id")
                   or payload.get("subagent_name") or "subagent")
        rows = _subagents.setdefault(session["id"], {})
        row = rows.setdefault(name, {"started": time.time(), "ended": None})
        if event == "SubagentStart":
            row.update(started=time.time(), ended=None)
        else:
            row["ended"] = time.time()
    return {}


def _on_stop(session: dict, usable) -> dict:
    """Once per turn: code changed and nothing tested it."""
    from bridge import runner
    if not usable("test_before_done"):
        return {}
    job = runner.live_job(session["id"])
    if job is None or job.id in _stop_asked:
        return {}
    with job._lock:   # noqa: SLF001 - the job's own list
        events = list(job.events)
    edited = any(e.get("type") == "tool" and e.get("name") in _CODE_EDIT for e in events)
    if not edited and not _changed_since(session.get("work_cwd") or session.get("cwd") or "", job.started):
        return {}
    tested = any((e.get("type") == "checks") or (e.get("type") == "tool" and _TEST_CMD.search(
        str(e.get("detail") or e.get("summary") or ""))) for e in events)
    if tested:
        return {}
    _stop_asked.add(job.id)
    if len(_stop_asked) > 2000:
        _stop_asked.clear()
    why = "You changed code this turn and nothing ran the tests. Run them, or say in your reply why you didn't."
    _note(session, "test_before_done", "Stop", "", "asked to test", "")
    return {"keep_going": why}


def _changed_since(cwd: str, since: float) -> bool:
    """A file git sees as changed that was written during this turn: an edit made through
    the shell uses no edit tool. Prose doesn't count."""
    if not cwd:
        return False
    try:
        p = subprocess.run(["git", "-C", cwd, "status", "--porcelain", "--no-renames"], capture_output=True,
                           text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    for line in p.stdout.splitlines():
        rel = line[3:].strip().strip('"')
        if rel.endswith((".md", ".markdown", ".txt")) or rel.startswith(".mystical"):
            continue
        try:
            if os.path.getmtime(os.path.join(cwd, rel)) >= since:
                return True
        except OSError:
            return True      # deleted: a change too
    return False


def _format(session: dict, tin) -> None:
    from bridge import fmt
    path = tin.get("file_path") if isinstance(tin, dict) else None
    if not path:
        return
    cwd = session.get("work_cwd") or session.get("cwd") or ""
    full = path if os.path.isabs(path) else os.path.join(cwd, path)
    try:
        with open(full, encoding="utf-8") as f:
            text = f.read()
        res = fmt.format_source(cwd, os.path.relpath(full, cwd), text)
        out = res.get("content") if isinstance(res, dict) else None
        if isinstance(out, str) and out != text:
            with open(full, "w", encoding="utf-8") as f:
                f.write(out)
            _note(session, "format_on_edit", "PostToolUse", os.path.basename(full), "formatted", "")
    except (OSError, UnicodeDecodeError, ValueError) as e:
        print(f"[rules] format: {e!r}", file=sys.stderr)


def _ping(session: dict, what: str) -> None:
    from bridge import runner
    try:
        runner._notify(session["chat_id"], f"⚠️ {what} — {runner._session_label(session['id'])}",
                       runner._session_kb(session["chat_id"], session["id"], "Open"), kind="agent_note",
                       sid=session["id"], body=what)
    except Exception as e:  # noqa: BLE001
        print(f"[rules] ping: {e!r}", file=sys.stderr)


def subagents_of(session_id: str) -> dict:
    return dict(_subagents.get(session_id) or {})


# ------- what each agent runs ---------------------------------------------------------

def _events_on(agent: str, project: "str | None", session: "dict | None") -> list:
    out = []
    for r in CATALOG:
        if agent in r["agents"] and state_of(r["id"], project, session)["on"]:
            out += [e for e in r["events"] if e not in out]
    return out


def dispatcher_command(event: str) -> str:
    import shlex
    return " ".join(shlex.quote(a) for a in (sys.executable, "-I", os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "hook_dispatch.py"), event))


def claude_hooks(session: "dict | None") -> dict:
    """--settings hooks for this Claude run: only the events a rule here is on for."""
    if not session:
        return {}
    return {e: [{"hooks": [{"type": "command", "command": dispatcher_command(e), "timeout": 30}]}]
            for e in _events_on("claude", session.get("project"), session)}


KIMI_BEGIN = "# >>> mystical rules: managed by Mystical, removed when no rule needs it"
KIMI_END = "# <<< mystical rules"
# What Kimi Code's config accepts: an unknown field stops it loading, so only these four.
KIMI_EVENTS = ("UserPromptSubmit", "PreToolUse", "Stop", "PostToolUse", "PostToolUseFailure", "SubagentStart",
               "SubagentStop", "PostCompact")


def _kimi_events() -> list:
    """Across machine and every project: the block is per login, a chat can't have its own.
    The bridge still decides per chat when the event arrives."""
    d = _load()
    scopes = [d.get("machine") or {}, *(d.get("projects") or {}).values()]
    out = []
    for r in CATALOG:
        if "kimi" not in r["agents"]:
            continue
        wanted = r["on"] and not any(r["id"] in s and not s[r["id"]].get("on") for s in scopes[:1])
        if wanted or any(s.get(r["id"], {}).get("on") for s in scopes) or (d.get("chat_used") or {}).get(r["id"]):
            out += [e for e in r["events"] if e in KIMI_EVENTS and e not in out]
    return out


def kimi_block(events: list) -> str:
    if not events:
        return ""
    rows = []
    for e in events:
        rows.append(f'[[hooks]]\nevent = "{e}"\ncommand = {json.dumps(dispatcher_command(e))}\ntimeout = 30\n')
    return f"{KIMI_BEGIN}\n" + "\n".join(rows) + f"{KIMI_END}\n"


def write_kimi_block(path: str, block: str) -> bool:
    """Put the block in one config.toml, replacing the old one, and refuse (leaving the file
    as it was) if the result isn't valid TOML. Returns whether it changed."""
    import tomllib
    try:
        with open(path, encoding="utf-8") as f:
            old = f.read()
    except FileNotFoundError:
        if not block:
            return False
        old = ""
    a, b = old.find(KIMI_BEGIN), old.find(KIMI_END)
    base = (old[:a] + old[b + len(KIMI_END):].lstrip("\n")) if a >= 0 and b > a else old
    new = base.rstrip("\n") + ("\n\n" + block if block else "\n")
    if new == old:
        return False
    tomllib.loads(new)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".mystical.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(new)
    os.replace(tmp, path)
    return True


def kimi_homes() -> list:
    from bridge import acp_agents
    homes = [os.path.expanduser(os.environ.get("KIMI_CODE_HOME") or "~/.kimi-code")]
    try:
        homes += [acp_agents.home_dir(a["id"]) for a in acp_agents.accounts("kimi") if a.get("kind") in ("home", "key")]
    except Exception as e:  # noqa: BLE001
        print(f"[rules] homes: {e!r}", file=sys.stderr)
    return homes


def sync_agents() -> None:
    """Keep the managed block matching the rules, only where Kimi is really set up.
    Best-effort: a rule must not fail to save because a config wouldn't write."""
    from bridge import experimental
    block = kimi_block(_kimi_events()) if experimental.enabled() else ""
    for home in kimi_homes():
        if not os.path.isdir(home):
            continue
        try:
            write_kimi_block(os.path.join(home, "config.toml"), block)
        except (OSError, ValueError) as e:
            print(f"[rules] kimi config: {e!r}", file=sys.stderr)
