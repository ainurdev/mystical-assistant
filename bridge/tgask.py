"""Questions and approvals answered from the Telegram chat, for any session.

A turn held on you (an AskUserQuestion card, or a tool its permission mode
asks about) used to ping "Claude needs …" with one button to the Mini App. Now
the ping carries the ask itself: a question with its options as buttons, an
approval with Allow in green and Deny in red (Bot API 9.4 button styles). A tap
answers the live turn (Job.respond, what the dashboard's card sends) and the
ping is rewritten to record it, its buttons turned into one grey label (10.3
disabled buttons). A text reply to the ping is a free answer: the question in
your own words, or for an approval a no with what to do instead.

What a chat can't answer whole still goes to the panel: a card with several
questions, or one that takes several picks, pings with the first question and
OPEN SESSION. Rivendell runs keep their own ping (rivendell.ping_question).

Memory only, as Rivendell's asks are: a restart ends the held turn anyway, and
a tap on its ping then says it was already answered.
"""

import threading
import uuid

from bridge import config, store, telegram, tgtopics

# shortcut: an unanswered ask, and every ping's message, stay until a restart (a few a day); prune if that grows.
_asks: "dict[str, dict]" = {}          # token -> {chat, sid, job, rid, kind, options, header, html}
_msgs: "dict[tuple[int, int], str]" = {}   # (chat, ping message id) -> token, kept: a late reply is told
SHOWN = 3000       # an approval longer than this offers no Allow: what it approves can't all be seen
_lock = threading.Lock()


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _entry(job, request_id: str) -> "dict | None":
    with job._lock:   # noqa: SLF001 — the pending list is the job's own
        return next((dict(p) for p in job.pending if p.get("request_id") == request_id), None)


def message(title: str, entry: dict, token: str, panel: "dict | None") -> "tuple[str, dict | None, list, bool]":
    """The ping for one held ask: its HTML, its buttons, the options a tap picks
    from, and whether the chat can answer it at all (a card with several
    questions, or several picks, can't). Pure, so the wording is testable."""
    rows: list = []
    options: list = []
    simple = True
    if entry.get("kind") == "question":
        qs = entry.get("questions") or [{}]
        q = qs[0]
        simple = len(qs) == 1 and not q.get("multiSelect")
        options = [o["label"] for o in q.get("options") or [] if isinstance(o, dict) and o.get("label")] if simple else []
        lead = (f"❓ <b>{_esc(title)}</b> asks" if simple
                else f"❓ <b>{_esc(title)}</b> has {len(qs)} questions" if len(qs) > 1
                else f"❓ <b>{_esc(title)}</b> asks (pick one or more)")
        lines = [lead, _esc(q.get("question") or "")]
        if simple:
            lines += ["", "<i>Or reply to this message in your own words.</i>"]
        rows = [[{"text": o[:60], "callback_data": f"ta:{token}:{i}"}
                 for i, o in enumerate(options) if k <= i < k + 2] for k in range(0, len(options), 2)]
    else:
        tool, inp = entry.get("tool_name") or "", entry.get("input") or {}
        cmd = inp.get("command") if tool == "Bash" and isinstance(inp.get("command"), str) else None
        # What Allow approves, whole: the summary is cut (120 chars of a command, 40 of an MCP field).
        what = cmd if cmd is not None else _mcp_detail(inp) if tool.startswith("mcp__") else ""
        whole = len(what) <= SHOWN
        lines = [f"🔐 <b>{_esc(title)}</b> wants to use {_esc(tool or 'a tool')}",
                 *([f"<pre>{_esc(what[:SHOWN])}</pre>"] if what else
                   [f"<code>{_esc(entry['summary'][:300])}</code>"] if entry.get("summary") else []),
                 *([] if whole else [f"<i>…and {len(what) - SHOWN} more characters. Open the session "
                                     "to see it all before you allow it.</i>"]),
                 "", "<i>Or reply to this message to say no, and what to do instead.</i>"]
        options = ["Allow", "Deny"]
        rows = [[*([{"text": "✓ Allow", "callback_data": f"ta:{token}:y", "style": "success"}] if whole else []),
                 {"text": "✕ Deny", "callback_data": f"ta:{token}:n", "style": "danger"}]]
        if cmd and len(cmd) <= 256:      # Telegram's cap; half a command is worse than none
            rows.append([{"text": "⎘ Copy command", "copy_text": {"text": cmd}}])
    rows += (panel or {}).get("inline_keyboard", [])
    return "\n".join(lines), ({"inline_keyboard": rows} if rows else None), options, simple


def _mcp_detail(inp) -> str:
    from bridge import runner   # local import: runner imports this module
    return runner._mcp_detail(inp)   # noqa: SLF001 — the panel's own text for an MCP call


def ping(chat_id: "int | None", session_id: "str | None", job_id: "str | None",
         request_id: "str | None") -> bool:
    """runner.notify_awaiting's Telegram half: send the held ask with its
    buttons, in the session's topic when it has one. False when there is
    nothing to send it about (the turn already moved on), and the caller pings
    the old way."""
    if not (chat_id and session_id and job_id and request_id and config.TOKEN):
        return False
    from bridge import runner   # local import: runner imports this module's callers
    job = runner.get_job(job_id)
    entry = _entry(job, request_id) if job else None
    if entry is None:
        return False
    sess = store.get_session(session_id) or {}
    token = uuid.uuid4().hex[:10]
    html, kb, options, simple = message(sess.get("title") or "Your session", entry, token,
                                        telegram.panel_kb(chat_id, session_id, sess.get("project"), "Open session ↗"))
    q = (entry.get("questions") or [{}])[0]
    sent = telegram.send(chat_id, html, kb, html=True, thread=tgtopics.thread_for(chat_id, session_id))
    if not sent:
        return False
    if simple:
        with _lock:
            _asks[token] = {"chat": chat_id, "sid": session_id, "job": job_id, "rid": request_id,
                            "kind": entry.get("kind"), "options": options, "html": html,
                            "header": q.get("header") or q.get("question") or ""}
            if isinstance(sent, dict) and sent.get("message_id"):
                _msgs[(chat_id, sent["message_id"])] = token
    return True


def _answer(token: str, *, pick: "int | None" = None, words: str = "") -> "tuple[str | None, dict | None]":
    """Answer the held ask behind `token` on its live turn. What was answered and
    the ask, or (None, ask) once it no longer waits (answered elsewhere, or the
    turn ended), so a stale tap never answers the next one."""
    with _lock:
        a = _asks.pop(token, None)
    if a is None:
        return None, None
    from bridge import runner   # local import: heavy module
    job = runner.get_job(a["job"])
    if job is None:
        return None, a
    if a["kind"] == "question":
        labels = [a["options"][pick]] if pick is not None and 0 <= pick < len(a["options"]) else []
        ans = {"header": a["header"], "labels": labels, **({"notes": words} if words else {})}
        ok = job.respond(a["rid"], answers=[ans])
        said = ", ".join(labels) or words
    else:
        allow = pick == 0 and not words
        ok = job.respond(a["rid"], behavior="allow" if allow else "deny",
                         message=words or None)
        said = "Allowed" if allow else (f"Denied: {words}" if words else "Denied")
    return (said if ok else None), a


def tap(chat_id: int, token: str, choice: str) -> "tuple[str | None, dict | None]":
    """A button on a ping (bridge/dispatch.py): `choice` is an option's index,
    y (allow) or n (deny). Only in the chat it was sent to."""
    with _lock:
        a = _asks.get(token)
    if a is None or a["chat"] != chat_id:
        return None, a
    pick = 0 if choice == "y" else 1 if choice == "n" else int(choice) if choice.isdecimal() else None
    return _answer(token, pick=pick)


def reply(chat_id: int, message_id: int, text: str) -> "tuple[str | bool | None, dict | None]":
    """A text reply to a ping: a free answer. None when it isn't one of these
    pings (the reply is an ordinary prompt); False once its ask no longer waits."""
    with _lock:
        token = _msgs.get((chat_id, message_id))
    if token is None:
        return None, None
    said, a = _answer(token, words=text)
    return (said or False), a


def answered(ask: dict, said: str) -> "tuple[str, dict]":
    """The ping once answered: what it asked, the answer, and one grey label
    where its buttons were."""
    html = f"{ask.get('html') or ''}\n\n✓ <b>{_esc(said)}</b>"
    return html, {"inline_keyboard": [[{"text": f"✓ {said}"[:60], "disabled": {}}]]}
