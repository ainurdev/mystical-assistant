"""A prompt sent from Telegram, run live, the way the dashboard and the Mini App
run theirs.

It used to run as one blocking `claude -p` call: "🤖 On it…", typing, then the
whole answer at the end, with no way to stop it, and a tool its mode asked
about simply denied (a chat couldn't show the card). Now it is an ordinary
streaming turn (runner.start_streaming_job), watched from here:

- 👀 on the prompt's own message as the turn starts, 👌 when it ends well, 😢
  when it fails: a receipt instead of a message.
- A draft (telegram.draft: Telegram's live preview of the message being
  written, Bot API 9.3/9.5) shows what Claude has said so far and the step it
  is on, with Telegram's own Stop button; the draft is sent again within its 30
  seconds while the turn runs. Stop interrupts the turn (Job.interrupt), as
  the panel's does.
- A question or an approval comes as its own ping with buttons (bridge/tgask.py).
- The answer is one rich message (telegram.send rich=True), in the session's
  topic when the chat has threads (bridge/tgtopics.py).

A turn that dies on an error and is picked up again (runner._maybe_auto_resume)
is followed to its end; one parked on a usage limit, retrying an API error or
stopped on a login says so in its own notice, sent here whatever the routes say
(Job.told). The turn's DONE ping is not sent for these: the answer is the message
(runner._announce_end reads Job.tg_live). A session on another agent stays in
the panel, as it did: the chat can't answer an agent's cards.

The bot chat keeps its posture: a session with no permission mode of its own
runs on the one EXTRA_CLAUDE_ARGS gives (--dangerously-skip-permissions is
Bypass), and the rest of those flags (--add-dir, --allowedTools...) still ride
along, as they did on the blocking path.
shortcut: a turn the runner resumes on its own (a crash, a limit reset, the ladder) runs
without them, on the session's mode or MINIAPP_PERMISSION_MODE; save the mode on the session if that bites.

ponytail: the draft grows a block of text at a time, as stream-json hands
complete text blocks (no --include-partial-messages: every consumer of the
stream would pay for word-level deltas). The step it is on fills the gaps.
"""

import os
import shlex
import threading
import time
import uuid

from bridge import config, notices, profiles, runner, state, telegram

TICK = 1.0          # how often the draft is looked at
REFRESH = 20.0      # a draft Telegram keeps 30 s is sent again within this
RESUME_WAIT = 3.0   # how long a dead turn's auto-resume is waited for

_live: "dict[int, object]" = {}    # draft id -> the job its Stop stops
_lock = threading.Lock()


def project_dir(session: dict) -> str:
    """Where a session runs when it has no cwd of its own yet."""
    return session.get("cwd") or os.path.join(config.BASE_PATH, (session.get("project") or "/").lstrip("/"))


def bot_args() -> "tuple[str | None, list[str]]":
    """EXTRA_CLAUDE_ARGS as the bot chat always ran them: the permission mode
    its flags set (the last one wins), and the rest of them."""
    mode, rest = None, []
    it = iter(shlex.split(config.EXTRA_CLAUDE_ARGS))
    for a in it:
        if a == "--dangerously-skip-permissions":
            mode = "bypassPermissions"
        elif a == "--permission-mode":
            mode = next(it, mode)
        elif a.startswith("--permission-mode="):
            mode = a.split("=", 1)[1]
        else:
            rest.append(a)
    return mode, rest


def start(chat_id: int, session: dict, prompt: str, files: "list[str] | None" = None, *,
          msg_id: "int | None" = None, thread: "int | None" = None) -> bool:
    """Run the prompt in `session`, watched live. False (and says so) when the
    session already has a turn going, or the bridge is going down."""
    eff = profiles.effective(session)
    if eff["agent"] != profiles.CLAUDE:
        telegram.send(chat_id, "This session runs on another agent — continue it in the "
                               "Mini App or the dashboard.", thread=thread)
        return False
    job_id = uuid.uuid4().hex
    paths = runner.adopt_uploads(job_id, files)
    mode, rest = bot_args()
    job = runner.start_streaming_job(chat_id, prompt, paths, project=project_dir(session),
                                     job_id=job_id, session_id=session["id"],
                                     # the session's (or its profile's) own mode wins
                                     permission_mode=None if eff["permission_mode"] else mode,
                                     extra_args=rest)
    if job is None:
        for p in paths:      # kept for the next try, as the old path kept them
            from bridge import tgfiles  # local import: tgfiles pulls telegram state
            tgfiles.hold(chat_id, p)
        telegram.send(chat_id, "⏳ Still working on this session. Wait for it, or press Stop.",
                      thread=thread)
        return False
    job.tg_live = True
    notices.emit("started", session["id"], body="from Telegram")
    threading.Thread(target=_watch, args=(job, chat_id, msg_id, thread),
                     name=f"tglive-{job_id[:8]}", daemon=True).start()
    return True


def stop(chat_id: int, draft_id: "int | None") -> bool:
    """Telegram's Stop under a draft (a stopped_message_generation update)."""
    with _lock:
        job = _live.get(draft_id or 0)
    return bool(job and job.chat_id == chat_id and job.interrupt())


def _texts(job) -> str:
    with job._lock:   # noqa: SLF001 — the job's own event list
        return "\n\n".join(e.get("text", "") for e in job.events if e.get("type") == "text").strip()


def draft_text(said: str, activity: dict) -> str:
    """What the draft shows: what Claude has said, then the step it is on. Pure."""
    state, label = activity.get("state"), activity.get("label") or ""
    step = ("_Waiting for your answer above._" if state == "awaiting"
            else f"_{label[:120]}_" if state == "tool" and label else "")
    return "\n\n".join(p for p in (said, step) if p)


def _watch(job, chat_id: int, msg_id: "int | None", thread: "int | None") -> None:
    draft_id = key = (int(job.id[:8], 16) % 2_000_000_000) or 1
    if msg_id:
        telegram.react(chat_id, msg_id, "👀")
    with _lock:
        _live[key] = job
    try:
        while True:
            _follow(job, chat_id, thread, draft_id)
            nxt = _resumed(job)
            if nxt is None:
                break
            nxt.tg_live = True        # the same turn, carried on: follow it too
            with _lock:
                _live[key] = nxt
            job = nxt
        _finish(job, chat_id, msg_id, thread)
    except Exception as e:  # noqa: BLE001 — a watcher must never take the bridge down
        print(f"[tglive] watching {job.id[:8]} failed: {e}")
    finally:
        with _lock:
            if _live.get(key) is job:
                _live.pop(key, None)


def _follow(job, chat_id: int, thread: "int | None", draft_id: int) -> None:
    """Keep the draft up to date until the turn's child has exited."""
    shown, at = None, 0.0
    while not job.exited.wait(TICK):
        if chat_id <= 0:
            continue          # drafts are for private chats only
        text = draft_text(_texts(job), job.activity())
        if text != shown or time.time() - at > REFRESH:
            telegram.draft(chat_id, draft_id, text, thread=thread)
            shown, at = text, time.time()


def _resumed(job) -> "object | None":
    """The turn that carries this one on after an error (runner._maybe_auto_resume
    runs right after the child exits), or None."""
    if job.status != "error" or job.interrupted or not job.store_session_id:
        return None
    deadline = time.time() + RESUME_WAIT
    while time.time() < deadline:
        nxt = runner.live_job(job.store_session_id)
        if nxt is not None and nxt is not job:
            return nxt
        time.sleep(0.2)
    return None


def _finish(job, chat_id: int, msg_id: "int | None", thread: "int | None") -> None:
    if state.shutting_down:
        return    # a restart killed it: boot recovery resumes it, and says so
    said = _texts(job)
    elapsed = int(time.time() - job.started)
    if job.interrupted:
        body = f"{said}\n\n⏹ Stopped." if said else "⏹ Stopped."
        emoji = None
    elif job.status == "error":
        why = job.error_msg or job.result or "the turn failed"
        if job.told:          # parked, retrying or signed out: that notice came here already
            if msg_id:
                telegram.react(chat_id, msg_id, "😢")
            return
        body = f"⚠️ {why}"
        emoji = "😢"
    else:
        body = job.result or said or "(no answer)"
        emoji = "👌"
    # A button under every answer would be noise; under one that failed or is
    # too long to read in a chat bubble, it's the way out.
    kb = (runner._session_kb(chat_id, job.store_session_id, "🛠 Open session")   # noqa: SLF001
          if job.status == "error" or len(body) > config.TG_MAX - 512 else None)
    sent = telegram.send(chat_id, f"{body}\n\n— {elapsed}s", kb, rich=True, thread=thread)
    if msg_id:
        telegram.react(chat_id, msg_id, emoji if sent else "😢")
