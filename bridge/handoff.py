"""Changing a chat's provider or account between turns, with the history kept.

Two kinds of memory are at work. The bridge's journal is the record of the chat,
whoever ran it. Each provider keeps its own session, in its own format, under its
own login, and nobody else can read it. So a provider's session is resumed when it
exists, and what it missed is told to it as text.

  - First time on a provider: the whole chat. Every prompt, answer and note goes in
    the prompt; the tool output, which is most of the bytes, goes in a file it can
    open (.mystical/handoff/<chat>.md). Measured on 293 real chats: without tool
    output the median is ~4k tokens, the 90th percentile ~12k, one chat over 200k.
    With it, the top of the range is 5.5M. A chat too big for the new model's
    window (agent_caps.history_budget) keeps its newest part, oldest dropped first,
    and the file still holds everything. The dialog says so before you confirm.
  - Back on a provider it already has a session with: resume it, and tell it only
    the turns since it last ran.

Why not translate the transcript into the other tool's session format: such tools
exist, and their authors call it context injection rather than migration. It breaks
with each CLI's update, and a real resume plus plain text does the same job.

A Claude account change isn't here: any login resumes the same session (accounts.py
shares projects/), so nothing is copied and no dialog is needed. An agent's account
change is here, because its session lives in that login's own home.

Stdlib only. Everything here is best-effort at turn time: a failure drops the
history from the prompt, with a log row, never the turn.
"""

import json
import os
import re
import sys

from bridge import agent_caps, profiles, store

CHARS_PER_TOKEN = 4
RECENT_TURNS = 5
_TOOL_OUT = 4000
FRAMED = re.compile(r"^(⏮|⧖|\[goal\]|⇄)")


def _tokens(text: str) -> int:
    return len(text) // CHARS_PER_TOKEN


def label(agent: str) -> str:
    if not agent or agent == profiles.CLAUDE:
        return "Claude"
    from bridge import acp_agents
    return (acp_agents.preset(agent) or {}).get("label") or agent


def _agent_of_runtime(runtime: "str | None") -> str:
    r = runtime or ""
    return r.split(":", 1)[1] if r.startswith("acp:") else profiles.CLAUDE


def _turn_block(s: dict, t: dict, *, tools: bool) -> str:
    """One turn as Markdown. With tools, what they returned too (the file)."""
    who = label(_agent_of_runtime(t.get("runtime")))
    out = []
    if t.get("prompt"):
        out.append(f"### {'Automatic' if FRAMED.match(t['prompt']) else 'User'}\n{t['prompt'].strip()}")
    words, closing = [], ""
    for e in store.events_of_turn(s["id"], t["id"]):
        k = e.get("type")
        if k == "text" and e.get("text"):
            words.append(e["text"].strip())
        elif k == "result" and e.get("result"):
            closing = e["result"].strip()
        elif k == "steer" and e.get("text"):
            words.append(f"(the user added: {e['text'].strip()})")
        elif k == "tool":
            line = f"- ran {e.get('name') or 'tool'}"
            if e.get("summary"):
                line += f": {str(e['summary'])[:160]}"
            words.append(line)
        elif k == "tool_done" and tools and e.get("output"):
            words.append("```\n" + str(e["output"])[-_TOOL_OUT:] + "\n```")
        elif k == "data":
            from bridge import data_views
            try:
                words.append(f"- showed {data_views.describe(e)}")
            except (KeyError, TypeError, ValueError):
                pass
        elif k == "error" and e.get("message"):
            words.append(f"(error: {str(e['message'])[:300]})")
    if closing and closing not in words:
        words.append(closing)
    if words:
        out.append(f"### {who}\n" + "\n".join(words))
    return "\n\n".join(out)


def _since(s: dict, agent: str, account: str = "", current: "str | None" = None) -> list:
    """The turns this agent hasn't seen: after its last one, or all of them when it
    has no session here to resume. `current` is the turn being started, which is
    already in the table and on this agent, so it counts for neither."""
    turns = [t for t in store.turns_of(s["id"]) if t["id"] != current]
    if not _has_native(s, agent, account):
        return turns
    last = -1
    for i, t in enumerate(turns):
        if _agent_of_runtime(t.get("runtime")) == agent:
            last = i
    return turns[last + 1:]


def _has_native(s: dict, agent: str, account: "str | None" = None) -> bool:
    if agent == profiles.CLAUDE:
        return bool(s.get("claude_session_id"))
    return bool(store.native_id(s["id"], agent, account or ""))


def _fit(blocks: list, budget: int) -> "tuple[list, bool]":
    """Newest blocks that fit in `budget` tokens, in order, and whether all did."""
    kept, used = [], 0
    for b in reversed(blocks):
        n = _tokens(b)
        if used + n > budget:
            return list(reversed(kept)), False
        kept.append(b)
        used += n
    return list(reversed(kept)), True


def refusal(s: dict) -> "str | None":
    """Why this chat can't change provider, or None."""
    origin = s.get("origin") or ""
    if origin.startswith("rivendell") or s.get("job"):
        return "A Rivendell job stays on its own agent."
    if origin.startswith(("team:", "device-run:")):
        return "This session is read only here."
    return None


def needs_dialog(s: dict, target: dict) -> bool:
    """Whether a change to this profile moves history, and so gets the dialog."""
    eff = profiles.effective(s)
    agent = target.get("agent") or profiles.CLAUDE
    if agent != eff["agent"]:
        return True
    return agent != profiles.CLAUDE and (target.get("account") or "") != eff["account"]


def preview(s: dict, target: dict) -> dict:
    """What the dialog shows, before anything changes."""
    agent = target.get("agent") or profiles.CLAUDE
    account = target.get("account") or ""
    native = _has_native(s, agent, account)
    turns = _since(s, agent, account)
    blocks = [b for b in (_turn_block(s, t, tools=False) for t in turns) if b]
    words = sum(_tokens(b) for b in blocks)
    with_tools = sum(_tokens(_turn_block(s, t, tools=True)) for t in turns)
    budget = agent_caps.history_budget(target.get("model"))
    return {"needs_dialog": needs_dialog(s, target) and bool(store.turns_of(s["id"])), "from": label(profiles.effective(s)["agent"]),
            "to": label(agent), "resumes": native, "turns": len(turns), "tokens": words,
            "with_tools": with_tools, "budget": budget, "fits": words <= budget,
            "recent": min(RECENT_TURNS, len(turns)), "refusal": refusal(s)}


def prepare(s: dict, target: dict, scope: str) -> None:
    """A change is confirmed: keep the session being left, bring back the one being
    returned to, and remember to tell the next turn. Called before profile_id moves."""
    eff = profiles.effective(s)
    if eff["agent"] != profiles.CLAUDE and s.get("agent_session_id"):
        store.set_native_id(s["id"], eff["agent"], eff["account"], s["agent_session_id"])
    agent = target.get("agent") or profiles.CLAUDE
    account = target.get("account") or ""
    if agent == profiles.CLAUDE:
        store.set_session_field(s["id"], "agent_session_id", None)
    else:
        store.set_session_field(s["id"], "agent_session_id",
                                store.native_id(s["id"], agent, account))
    store.set_session_field(s["id"], "handoff", json.dumps({
        "from": eff["agent"], "to": agent, "scope": "recent" if scope == "recent" else "whole",
        "account": account}))


def _write_file(s: dict, cwd: str, turns: list) -> "str | None":
    """The whole chat with its tool output, for the agent to open. In .mystical/,
    which ignores itself, so it never reaches git."""
    try:
        d = os.path.join(cwd, ".mystical", "handoff")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, f"{s['id']}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"# Chat history: {s.get('title') or s['id']}\n\n")
            for t in turns:
                b = _turn_block(s, t, tools=True)
                if b:
                    f.write(b + "\n\n")
        return os.path.relpath(path, cwd)
    except OSError as e:
        print(f"[handoff] file: {e!r}", file=sys.stderr)
        return None


def consume(s: dict, cwd: str, model: "str | None",
            current: "str | None" = None) -> "tuple[str, dict | None]":
    """(text to lead this turn's prompt with, the switch row for the transcript).
    Empty when no change is waiting. The change stays recorded until the turn is
    done (finished), so a turn that dies before its agent read it retries it."""
    raw = store.parse_json(s.get("handoff"))
    if not raw:
        return "", None
    try:
        agent = raw.get("to") or profiles.CLAUDE
        turns = _since(s, agent, raw.get("account") or "", current)
        resumed = _has_native(s, agent, raw.get("account"))
        shown = turns[-RECENT_TURNS:] if raw.get("scope") == "recent" else turns
        blocks = [b for b in (_turn_block(s, t, tools=False) for t in shown) if b]
        kept, whole = _fit(blocks, agent_caps.history_budget(model))
        row = {"type": "switch", "from": label(raw.get("from")), "to": label(agent),
               "turns": len(kept), "whole": whole and len(shown) == len(turns)}
        if not kept:
            return "", row
        path = _write_file(s, cwd, [t for t in store.turns_of(s["id"]) if t["id"] != current])
        head = (f"This chat was running on {label(raw.get('from'))} and has moved to you. "
                if not resumed else
                f"You are back in this chat. While you were away {label(raw.get('from'))} ran it. ")
        note = "" if row["whole"] else " What follows is the newest part; it doesn't all fit here."
        where = f" The full history, with tool output, is in {path}." if path else ""
        text = (f"⇄ {head}Here is what happened, so you can carry on.{note}{where}\n\n"
                + "\n\n".join(kept) + "\n\n⇄ End of history. The user's message follows.\n\n")
        return text, row
    except Exception as e:  # noqa: BLE001 - a history never blocks a turn
        print(f"[handoff] {e!r}", file=sys.stderr)
        return "", None


def finished(session_id: str) -> None:
    """A turn on the new provider completed: it has the history now."""
    s = store.get_session(session_id)
    if s and s.get("handoff"):
        store.set_session_field(session_id, "handoff", None)


def remember_native(session_id: str, agent: str, account: str, native: str) -> None:
    """The agent's session id as soon as it exists, so a switch away can return."""
    try:
        store.set_native_id(session_id, agent, account, native)
    except Exception as e:  # noqa: BLE001
        print(f"[handoff] remember: {e!r}", file=sys.stderr)
