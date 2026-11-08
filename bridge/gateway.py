"""The tool server every agent gets from Mystical, whatever its vendor.

Each run gets a token that reaches this module for one session, for as long as that
turn lasts, and nothing else. The agent starts bridge/gateway_relay.py, which knows
nothing, and everything happens here in the bridge process. That's the scoped token
the profiles-and-acp-agents spec was waiting for: third-party CLIs never get the
dashboard token, and a shared server's key or OAuth token stays here.

What a session gets depends on what it is and what it lacks (agent_caps):
  - Claude's chats get the helper and channel tools, plus find_tools/call_tool if a
    server from another agent was shared with Claude. Everything else it has natively,
    and its appended prompt doesn't change, so its cache is untouched.
  - An agent also gets what Claude has natively: ask_user, goals, run_project, Rivendell
    tasks and shared servers.
  - A helper gets the channel but not delegate: depth is 1.
  - A Rivendell job or one-shot gets no gateway at all (runner decides).

Shared servers are two meta tools, not one tool per upstream tool. A session pays nothing
until it wants one, no server starts at session start (seconds per turn otherwise), and
an agent with no deferred-tool search doesn't carry a server's whole catalogue. The
agent's own permission flow covers the call, like any MCP call it makes, and it's in
the turn's journal as a tool row.

A card. Claude's MCP calls may wait, so the tool call blocks on the answer. An agent's
can't (Kimi Code times a call out at 60 s), so the tool returns at once, the turn pauses
on the same connection once it does (acp.pause_for_card), and the answer is the next prompt.
"""

import os
import secrets
import shlex
import sys
import threading
import time
import uuid

from bridge import (acp, agent_caps, channel, config, experimental, gateway_tools, goals, mcp_client, mcp_share,
                    profiles, store, tool_policy, worklist)

_tokens: dict = {}        # token -> {session_id}
_lock = threading.Lock()
_cards: dict = {}         # request id -> {done: Event, answers, on_answer}


def issue(session_id: str) -> str:
    tok = secrets.token_urlsafe(32)
    with _lock:
        _tokens[tok] = {"session_id": session_id, "at": time.time()}
    return tok


def revoke(tok: "str | None") -> None:
    if tok:
        with _lock:
            _tokens.pop(tok, None)


def session_of(tok: "str | None") -> "str | None":
    if not tok or not experimental.enabled():
        return None
    with _lock:
        row = _tokens.get(tok)
    return row["session_id"] if row else None


def server_def(tok: str) -> dict:
    """How a claude child starts the relay (--mcp-config's shape)."""
    return {"command": sys.executable,
            "args": ["-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gateway_relay.py")],
            "env": _env(tok)}


def acp_server(tok: str) -> dict:
    """The same, in session/new's shape."""
    d = server_def(tok)
    return {"name": "mystical", "command": d["command"], "args": d["args"],
            "env": [{"name": k, "value": v} for k, v in d["env"].items()]}


def hook_env(tok: str) -> dict:
    """What bridge/hook_dispatch.py needs in the agent's environment. Same token and reach as
    the relay: it's dead when the turn ends."""
    return {"MYSTICAL_HOOK_TOKEN": tok, "MYSTICAL_HOOK_URL": f"http://127.0.0.1:{config.DASH_PORT}/local/hook"}


def hook(tok: "str | None", body: dict) -> "tuple[dict, int]":
    """POST /local/hook. A rule's answer; {} lets the action through."""
    sid = session_of(tok)
    s = store.get_session(sid) if sid else None
    if not s:
        return {"error": "unauthorized"}, 401
    from bridge import rules
    try:
        return rules.evaluate(s, str(body.get("event") or ""), body.get("payload") or {}), 200
    except Exception as e:  # noqa: BLE001 - a rule must never be what stops the work
        print(f"[gateway] rule: {e!r}", file=sys.stderr)
        return {}, 200


def _env(tok: str) -> dict:
    return {"MYSTICAL_GATEWAY_URL": f"http://127.0.0.1:{config.DASH_PORT}/local/gateway",
            "MYSTICAL_GATEWAY_TOKEN": tok}


def eligible(session: "dict | None") -> bool:
    """Whether this run gets the gateway. Rivendell's unattended jobs never do: they
    keep exactly the tools they had."""
    if not session or not experimental.enabled():
        return False
    origin = session.get("origin") or ""
    return not (origin.startswith(("rivendell", "team:", "device-run:")) or session.get("job"))


# ------- tools -------------------------------------------------------------

def _t(name: str, description: str, props: "dict | None" = None, required: "list | None" = None) -> dict:
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props or {}, "required": required or []}}


_NAME = {"type": "string", "description": "The helper's name, as list_agents shows it."}
DELEGATE = _t(
    "delegate",
    "Start helpers: other agents, on any provider, that Mystical runs and shows under this chat. "
    "Use it only when the user asked for help from another agent, or for work to run in parallel. "
    "Give independent tasks: tasks touching the same files are better done in order, by you. "
    "Each writer gets its own copy of the code; a reader (the default) sees this folder and changes "
    "nothing. A result arrives as a message and wakes you, so end your turn afterwards.",
    {"tasks": {"type": "array", "description": "One entry per helper.", "items": {
        "type": "object", "required": ["brief"], "properties": {
            "brief": {"type": "string", "description": "Everything it needs: the goal, the files, "
                      "what to report. It doesn't see this conversation."},
            "name": {"type": "string", "description": "Short name, e.g. reviewer."},
            "write": {"type": "boolean", "description": "True if it must change code."},
            "profile": {"type": "string", "description": "A profile name from list_agents, if the user "
                        "asked for one. Leave it out and Mystical chooses."}}}}},
    ["tasks"])
SEND = _t("send_message", "Send a message to another agent in this chat. Use `main` for the chat's "
          "main agent, or `all`. Only they receive it; the log stays readable by everyone. It wakes "
          "them or reaches them at their next step.",
          {"to": {"type": "string"}, "text": {"type": "string"}}, ["to", "text"])
LIST = _t("list_agents", "Who is in this chat, what each is doing, and the profiles a helper can use.")
READ = _t("read_channel", "Read this chat's message log.",
          {"limit": {"type": "integer", "description": "How many of the newest. Default 30."}})
REVIEW = _t("review_helper_changes", "See what a writer helper changed in its copy of the code.",
            {"name": _NAME}, ["name"])
MERGE = _t("merge_helper_changes", "Review first. Applies a writer's changes to your folder as "
           "uncommitted changes: nothing is committed or pushed.", {"name": _NAME}, ["name"])
DISCARD = _t("discard_helper_changes", "Drop a writer's copy of the code.", {"name": _NAME}, ["name"])
ASK = _t("ask_user", "Ask the user with a card to tap. Your turn pauses and the answer is your next message.",
         {"questions": {"type": "array", "items": {
             "type": "object", "required": ["question", "options"], "properties": {
                 "question": {"type": "string"}, "header": {"type": "string"},
                 "multiSelect": {"type": "boolean"},
                 "options": {"type": "array", "items": {
                     "type": "object", "required": ["label"], "properties": {
                         "label": {"type": "string"}, "description": {"type": "string"}}}}}}}},
         ["questions"])
GOAL_C = _t("create_goal", "Keep working on one objective across turns until you mark it complete.",
            {"objective": {"type": "string"}}, ["objective"])
GOAL_U = _t("update_goal", "Mark the goal complete, or blocked with a note saying what you need.",
            {"state": {"type": "string", "enum": ["complete", "blocked"]}, "note": {"type": "string"}}, ["state"])
GOAL_G = _t("get_goal", "This chat's goal and how many turns it has used.")
RUN = _t("run_project", "Start or stop this project's dev server, owned by Mystical so it outlives your turn.",
         {"action": {"type": "string", "enum": ["start", "stop"]},
          "command": {"type": "string", "description": "Leave out to let Mystical detect it."}})
RV_LIST = _t("list_rivendell_tasks", "The open tasks on this repo's Rivendell board.")
RV_NEW = _t("create_rivendell_task", "Create a task on this repo's Rivendell board. Returns its key.",
            {"title": {"type": "string"}, "description": {"type": "string"}, "board": {"type": "string"}},
            ["title"])
WORK_LIST = _t("work_list", "The project's work list, which the user sees in the right sidebar and which outlives this chat. Change it "
               "only when the user asks. Fill it from wherever they name, a tracker, notes, anything, using whichever tools you "
               "have: Mystical doesn't sync with anything. replace makes the list what you give it: an item named by id or "
               "source ref keeps its state, open items you leave out go, and finished ones stay unless clear_done. Only the "
               "user starts a run on the list.",
               {"action": {"type": "string", "enum": ["read", "add", "update", "remove", "replace", "reorder"]},
                "items": {"type": "array", "description": "For add, update and replace.", "items": {"type": "object", "properties": {
                    "id": {"type": "string", "description": "For update, and to keep an item in replace."},
                    "title": {"type": "string"}, "detail": {"type": "string", "description": "What's needed: a helper may only ever see this."},
                    "state": {"type": "string", "enum": ["todo", "blocked", "done", "dropped"]}, "note": {"type": "string"},
                    "depends_on": {"type": "array", "items": {"type": "string"}, "description": "Ids that must be done first."},
                    "source": {"type": "object", "description": "Where it came from: {kind, ref, url}."}}}},
                "ids": {"type": "array", "items": {"type": "string"}, "description": "For remove and reorder."},
                "clear_done": {"type": "boolean"}}, ["action"])
WORK_RUN = _t("work_run", "Manage a run on the work list, once the user has started one here: you assign items to helpers, review "
              "and merge. status shows it. start_item gives an item a helper in its own copy of the code. review_item shows what it "
              "changed. merge_item merges it into the run's branch, never the user's. send_back returns it with what to change. "
              "block_item says it needs the user. restart_item drops its copy and puts it back up next. finish ends the run. You "
              "can't start a run: only the user can.",
              {"action": {"type": "string", "enum": ["status", "start_item", "review_item", "merge_item", "send_back", "block_item", "restart_item", "finish"]},
               "id": {"type": "string", "description": "The item, for everything but status and finish."},
               "brief": {"type": "string", "description": "start_item: anything to add to the task's own text. The helper sees nothing else."},
               "profile": {"type": "string", "description": "start_item: a profile name from list_agents, if the user asked for one."},
               "text": {"type": "string", "description": "send_back: what to change. block_item: what you need from the user."},
               "summary": {"type": "string", "description": "finish: what happened."}}, ["action"])
FIND = _t("find_tools", "Find more tools: Mystical's rarer ones (reports, chat search, waiting, pinging the user, "
          "secrets) and MCP servers shared with you. Empty query lists servers.",
          {"query": {"type": "string"}, "server": {"type": "string"}})
CALL = _t("call_tool", "Call a tool that find_tools showed. Use server `mystical` for Mystical's own.",
          {"server": {"type": "string"}, "tool": {"type": "string"}, "arguments": {"type": "object"}},
          ["server", "tool"])


def _rivendell_on(s: dict) -> bool:
    try:
        from bridge import aifeatures, integrations, rivendell, rivendell_instances
        return bool(integrations.installed("rivendell") and aifeatures.enabled("rvtrack")
                    and any(i.get("enable") for i in rivendell_instances.instances())
                    and rivendell.on_board(s.get("work_cwd") or s.get("cwd") or ""))
    except Exception:  # noqa: BLE001 - tools/list must still answer
        return False


def _agent_of(s: dict) -> str:
    return profiles.effective(s)["agent"]


def tools_for(s: dict) -> list:
    """What this session's agent may call right now."""
    agent = _agent_of(s)
    caps = agent_caps.caps(agent)
    out = [SEND, LIST, READ]
    if not s.get("parent_session") and channel.refusal(s) is None:
        out += [DELEGATE, REVIEW, MERGE, DISCARD]
    if not s.get("parent_session"):
        out += [WORK_LIST, WORK_RUN]
    if not caps["system_prompt"]:          # an agent: what Claude has natively
        out += [ASK, RUN]
        if not s.get("parent_session"):
            out += [GOAL_C, GOAL_U, GOAL_G]
        if _rivendell_on(s):
            out += [RV_LIST, RV_NEW]
    out += list(gateway_tools.CORE_ALL)
    # The rest are behind find_tools, so they cost nothing until wanted.
    out += [FIND, CALL]
    return _allowed(s, out)


def _allowed(s: dict, tools: list) -> list:
    """Less what's switched off here (SETTINGS > Agent Tools). find_tools and call_tool are how
    the rest are reached, so they stay."""
    off = tool_policy.gateway_off(_agent_of(s), s.get("project"), s, {t["name"] for t in tools})
    return [t for t in tools if t["name"] not in off or t["name"] in ("find_tools", "call_tool")]


def _extras(s: dict) -> list:
    """Mystical's own tools that find_tools lists rather than tools/list."""
    caps = agent_caps.caps(_agent_of(s))
    return _allowed(s, list(gateway_tools.EXTRA_ALL) + ([] if caps["system_prompt"] else list(gateway_tools.EXTRA_AGENT)))


def tool_names(s: dict) -> set:
    return {t["name"] for t in tools_for(s)}


# ------- cards -------------------------------------------------------------

def _card(job, s: dict, questions: list, on_answer) -> dict:
    """Show a question card. See _show_card."""
    ask = ((questions or [{}])[0].get("question") or "")[:300]
    return _show_card(job, s, {"kind": "question", "tool_name": "ask_user", "questions": questions},
                      {"type": "question", "questions": questions}, on_answer, ask, tappable=True)


def card_of_kind(job, s: dict, kind: str, fields: dict, on_answer, ping: str) -> dict:
    """A card that isn't a question (request_secret): its own event, `<kind>_request`.
    It can't be answered from a Telegram message, so the ping just opens the chat."""
    return _show_card(job, s, {"kind": kind, "tool_name": f"request_{kind}", **fields},
                      {"type": f"{kind}_request", **fields}, on_answer, ping, tappable=False)


def _show_card(job, s: dict, entry: dict, event: dict, on_answer, ask: str, tappable: bool) -> dict:
    """Show a card. Returns the tool's result: the answer when this agent's call can
    wait for one, else what to do meanwhile."""
    from bridge import runner
    rid = f"gw-{uuid.uuid4().hex[:12]}"
    done = threading.Event()
    with _lock:
        _cards[rid] = {"done": done, "answers": None, "on_answer": on_answer, "text": None}
    block = agent_caps.caps(_agent_of(s))["block"]
    if not block and not acp.pause_for_card(job):
        with _lock:
            _cards.pop(rid, None)
        return _text("This turn can't pause right now. Say what you need in your reply instead.")
    job.add_pending({"request_id": rid, **entry, "gateway": True, "at": time.time()})
    job.add({**event, "request_id": rid})
    kw = {"job_id": job.id, "request_id": rid} if tappable else {}
    threading.Thread(target=runner.notify_awaiting, daemon=True,
                     args=(job.chat_id, job.store_session_id, "question"),
                     kwargs={"body": ask, **kw}).start()
    if not block:
        return _text("The card is shown. End your turn now, without doing anything else: the answer "
                     "arrives as your next message.")
    while not done.wait(1.0):
        if job.exited.is_set() or job.status != "running":
            with _lock:
                _cards.pop(rid, None)
            return _text("The turn ended before the card was answered.")
    with _lock:
        row = _cards.pop(rid, {})
    return _text(row.get("text") or "No answer.")


def answer_card(job, entry: dict, answers: "list | None") -> None:
    """A click on a gateway card (Job.respond, AcpJob.respond)."""
    from bridge import runner
    rid = entry["request_id"]
    if entry.get("kind") == "question":
        job.add({"type": "question_answered", "request_id": rid, "answers": answers or []})
    with _lock:
        row = _cards.get(rid)
    if row is None:
        return
    try:
        text = row["on_answer"](answers or [])
    except Exception as e:  # noqa: BLE001
        print(f"[gateway] card: {e!r}", file=sys.stderr)
        text = f"That answer couldn't be acted on: {e}"
    if entry.get("kind") != "question":
        # After acting on it, so the card says what happened. Never the answers: a
        # secret's value goes in neither the journal nor the chat.
        ok, text = text if isinstance(text, tuple) else (False, text)
        job.add({"type": f"{entry.get('kind')}_answered", "request_id": rid, "given": ok})
    row["text"] = text
    row["answers"] = answers
    row["done"].set()
    if isinstance(job, runner.AcpJob):
        acp.card_answered(job, text)
        with _lock:
            _cards.pop(rid, None)


def _text(s: str, error: bool = False) -> dict:
    out = {"content": [{"type": "text", "text": s}]}
    if error:
        out["isError"] = True
    return out


# ------- dispatch ----------------------------------------------------------

def handle(tok: "str | None", method: str, params: dict) -> "tuple[dict, int]":
    """POST /local/gateway. The token is all the authority there is."""
    sid = session_of(tok)
    s = store.get_session(sid) if sid else None
    if not s:
        return {"error": "unauthorized"}, 401
    if method == "tools/list":
        return {"tools": tools_for(s)}, 200
    if method != "tools/call":
        return {"error": f"no method {method}"}, 400
    name = params.get("name") or ""
    args = params.get("arguments") or {}
    if name not in tool_names(s) and name not in {t["name"] for t in _extras(s)}:
        return _text(f"{name} isn't available to this session.", error=True), 200
    try:
        return _call(s, name, args), 200
    except Exception as e:  # noqa: BLE001 - the agent reads it and routes around it
        print(f"[gateway] {name}: {e!r}", file=sys.stderr)
        return _text(f"{name} failed: {e}", error=True), 200


def _call(s: dict, name: str, a: dict) -> dict:
    from bridge import runner
    chat = store.get_session(s["parent_session"]) if s.get("parent_session") else s
    me = channel._name_of(s)
    job = runner.live_job(s["id"])
    if name == "delegate":
        return _delegate(s, job, a)
    if name == "send_message":
        to, text = str(a.get("to") or ""), str(a.get("text") or "")
        if not text.strip():
            return _text("The message is empty.", error=True)
        if to != "all" and channel._target(chat, to) is None:
            return _text(f'No agent is called "{to}". {_roster(chat)}', error=True)
        m = channel.post(chat, me, to, "message", text)
        if m["state"] == "dropped":
            return _text("Dropped: you just sent them the same thing.")
        if m["state"] == "held":
            return _text("The channel is on hold. The user will see this and may release it.")
        return _text(f"Sent to {to}.")
    if name == "list_agents":
        return _text(_roster(chat))
    if name == "read_channel":
        rows = store.channel_messages(chat["id"], limit=min(int(a.get("limit") or 30), 200))
        return _text("\n\n".join(f"[{m['sender']} → {m['recipient']}] {m['body']}" for m in rows) or "Nothing yet.")
    if name == "review_helper_changes":
        return _text(channel.changes(chat, str(a.get("name") or "")))
    if name == "merge_helper_changes":
        return _text(channel.merge(chat, str(a.get("name") or "")))
    if name == "discard_helper_changes":
        return _text(channel.discard(chat, str(a.get("name") or "")))
    if name == "ask_user":
        return _ask_user(s, job, a)
    if name == "create_goal":
        objective = str(a.get("objective") or "").strip()
        if not objective:
            return _text("objective is required.", error=True)
        goals.create(s["id"], objective)
        return _text(f"Goal set. You will be prompted again after each turn, up to {goals.MAX_ITER}, "
                     "until you call update_goal.")
    if name == "update_goal":
        state = str(a.get("state") or "")
        if state not in (goals.COMPLETE, goals.BLOCKED):
            return _text("state must be complete or blocked.", error=True)
        if goals.mark(s["id"], state, str(a.get("note") or "").strip()) is None:
            return _text("No active goal.")
        return _text(f"Goal marked {state}.")
    if name == "get_goal":
        g = goals.get(s["id"])
        return _text(f"{g.get('objective')}\nState: {g.get('state')}\nTurns: {g.get('iter', 0)}/{goals.MAX_ITER}"
                     if g else "No active goal.")
    if name == "run_project":
        return _text(_run_project(s, a))
    if name in ("list_rivendell_tasks", "create_rivendell_task"):
        return _text(_rivendell(s, name, a))
    if name == "work_list":
        try:
            return _text(worklist.tool(s, a))
        except worklist.Refused as e:
            return _text(str(e), error=True)
    if name == "work_run":
        from bridge import workrun
        try:
            return _text(workrun.tool(s, a))
        except worklist.Refused as e:
            return _text(str(e), error=True)
    if name == "find_tools":
        return _text(_find(s, a))
    if name == "call_tool":
        if a.get("server") == "mystical":
            inner = str(a.get("tool") or "")
            if inner not in {t["name"] for t in _extras(s)}:
                return _text(f"{inner} isn't available to this session.", error=True)
            return gateway_tools.call(s, job, inner, a.get("arguments") or {})
        return _call_shared(s, a)
    if name in gateway_tools.HANDLED:
        return gateway_tools.call(s, job, name, a)
    return _text(f"Unknown tool: {name}", error=True)


def _roster(chat: dict) -> str:
    from bridge import agent_tree
    rows = [r for r in agent_tree.tree(chat) if r["kind"] == "member"]
    who = ["main: the chat's main agent"] + [
        f"{r['name']}: {r['status']} on {r['provider']}{', writer' if r['write'] else ', read only'}"
        for r in rows]
    names = ", ".join(p["name"] for p in profiles.all_profiles()) or "none"
    return "Agents here:\n" + "\n".join(who) + f"\nProfiles a helper can use: {names}"


def _delegate(s: dict, job, a: dict) -> dict:
    plan, why = channel.plan_tasks(s, a.get("tasks"))
    if why:
        return _text(why, error=True)
    if channel.needs_card(s):
        def on_answer(answers: list) -> str:
            if not channel.approved(answers):
                return "The user said not now. Carry on alone."
            fresh, again = channel.plan_tasks(store.get_session(s["id"]), a.get("tasks"))
            if again:
                return again
            return _started(s, fresh)
        return _card(job, s, channel.card_questions(plan), on_answer)
    return _text(_started(s, plan))


def _started(s: dict, plan: list) -> str:
    lines = channel.start(store.get_session(s["id"]), plan)
    return "\n".join(lines) + "\nEnd your turn: each result arrives as a message and wakes you."


def _ask_user(s: dict, job, a: dict) -> dict:
    from bridge import runner
    questions = a.get("questions")
    if not isinstance(questions, list) or not questions:
        return _text("Give at least one question with options.", error=True)
    if job is None:
        return _text("No turn is running to ask from.", error=True)

    def on_answer(answers: list) -> str:
        return "The user answered your card:\n" + runner._format_answers(questions, answers)
    return _card(job, s, questions, on_answer)


def _run_project(s: dict, a: dict) -> str:
    """The same route the verify server's Run tool uses, from inside the bridge."""
    import json
    import urllib.error
    import urllib.request
    body = json.dumps({"action": "stop" if a.get("action") == "stop" else "start",
                       "cwd": s.get("work_cwd") or s.get("cwd") or "",
                       "cmd": str(a.get("command") or "").strip()}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{config.DASH_PORT}/local/server", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Dash-Token": config.DASH_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.load(r)
    except (urllib.error.URLError, OSError, ValueError) as e:
        return f"Could not start it: {e}"
    msg = data.get("message") or "Done."
    srv = data.get("server") or {}
    return f"{msg}\nThe human can follow it in the dashboard: {srv['url']}" if srv.get("url") else msg


def _rivendell(s: dict, name: str, a: dict) -> str:
    """Same functions as the Claude tools' route (POST /local/rivendell/work)."""
    from bridge import rivendell
    cwd = s.get("work_cwd") or s.get("cwd") or ""
    if name == "list_rivendell_tasks":
        return rivendell.work_list(cwd)
    return rivendell.work_create(cwd, title=str(a.get("title") or ""),
                                 description=str(a.get("description") or ""),
                                 board=str(a.get("board") or ""))


def _shared(s: dict) -> dict:
    return mcp_share.for_agent(_agent_of(s), s.get("cwd"), s.get("project"), s)


def _find(s: dict, a: dict) -> str:
    query, only = str(a.get("query") or "").lower(), str(a.get("server") or "")
    servers = _shared(s)
    if not query and not only:
        return "Servers: mystical (Mystical's own tools), " + (", ".join(sorted(servers)) or "none shared") \
            + ". Call find_tools with a query or a server to see tools."
    lines, problems = [], []
    if not only or only == "mystical":
        for t in _extras(s):
            hay = f"{t['name']} {t['description']}".lower()
            if not query or query in hay:
                lines.append(f"mystical / {t['name']}: {t['description'][:200]}\n  input: {shlex.quote(_schema(t))}")
    for name, d in servers.items():
        if only and name != only:
            continue
        try:
            tools = mcp_share.tools_of(name, d)
        except mcp_client.McpError as e:
            problems.append(f"{name}: {e}")
            continue
        for t in tools:
            tool = t.get("name") or ""
            hay = f"{tool} {t.get('description') or ''}".lower()
            if mcp_share.tool_allowed(name, tool) and (not query or query in hay):
                lines.append(f"{name} / {tool}: {(t.get('description') or '')[:200]}\n"
                             f"  input: {shlex.quote(_schema(t))}")
    return "\n".join(lines[:40] + problems) or "No tool matches."


def _schema(t: dict) -> str:
    import json
    return json.dumps(t.get("inputSchema") or {})[:800]


def _call_shared(s: dict, a: dict) -> dict:
    server, tool = str(a.get("server") or ""), str(a.get("tool") or "")
    d = _shared(s).get(server)
    if d is None:
        return _text(f"{server} isn't shared with this agent.", error=True)
    if not mcp_share.tool_allowed(server, tool):
        return _text(f"{tool} is held back: it can reveal secrets or change infrastructure. The user "
                     "can enable it by name in Settings.", error=True)
    try:
        res = mcp_share.call(server, d, tool, a.get("arguments") or {})
    except mcp_client.NeedsLogin:
        return _text(f"{server} needs a login. The user can do it in Settings, under shared servers.", error=True)
    except mcp_client.McpError as e:
        return _text(f"{server} / {tool} failed: {e}", error=True)
    return {"content": res.get("content") or [{"type": "text", "text": "(no output)"}],
            **({"isError": True} if res.get("isError") else {})}
