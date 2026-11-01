"""Startup recovery: resume turns a restart interrupted.

When the bridge is stopped/restarted mid-turn its Claude child dies with it and
the turn is left 'running' (the runner skips finish_turn once state.shutting_down
is set). On the next start we claim those orphaned turns and, for each resumable
one, resume its Claude session (--resume) with a short "you were interrupted,
continue" nudge. An agent turn (runtime acp:<id>, bridge/acp.py) resumes the
same way on the agent's own session (agent_session_id): the restart's kill
leaves it 'running' too (runner.AcpJob.add), and its run reopens that session
with session/resume or session/load. No cooldown: every boot-resume traces to a human restarting the
bridge, so it cannot self-loop — the crash-loop cap for resumes that keep dying
lives in the runner's mid-run auto-resume (runner.AUTO_RESUME_MAX).
"""

import sys

from bridge import config, ladder, notices, queue_manager, runner, store, telegram

NUDGE = (
    "⏮ You were interrupted mid-task by a bridge restart — not by the user. "
    "Review your recent transcript and continue exactly where you left off; "
    "finish the task you were doing. Don't start over.")


def recover(*, run=None, notify=None) -> int:
    """Claim orphaned turns and auto-resume the resumable ones; returns the number
    resumed. Claiming always flips the orphans to 'error' (UI hygiene) even when
    auto-resume is off. `run`/`notify` are injectable for tests."""
    run = run or runner.start_streaming_job
    notify = notify or telegram.send

    orphaned = store.claim_orphaned_turns()          # also flips them to 'error'
    if not config.AUTO_RESUME:
        return 0

    resumed_sessions: set[str] = set()
    count = 0
    for t in orphaned:
        sid = t["session_id"]
        if sid in resumed_sessions:
            continue                                  # one in-flight turn per session
        agent = (t["runtime"] or "").startswith("acp:")
        if not (t["agent_session_id"] if agent else t["claude_session_id"]):
            continue                                  # died before init — nothing to resume
        if not config.is_owner(t["chat_id"]):
            continue
        if queue_manager.owns_session(sid):
            continue                                  # a Rivendell batch's queue resumes it, not a nudge
        resumed_sessions.add(sid)
        try:
            # An agent turn: no slot or runtime from here, so the session's own
            # profile picks the agent and account, with its owner check (rule 6).
            slot, runtime = (None, None) if agent else ladder.same_agent(t["runtime"])
            # model=None: the session's own, read when the run starts, so a pick
            # made while the turn ran (a live switch) survives the restart.
            job = run(t["chat_id"], NUDGE, [], project=t["cwd"],
                      session_id=sid, model=None,
                      account_slot=slot, runtime=runtime)
        except Exception as e:  # noqa: BLE001
            print(f"[recovery] resume failed for {sid}: {e}", file=sys.stderr)
            continue
        if job is None:
            continue                                  # session busy (shouldn't happen at boot)
        count += 1
        notices.emit("resumed", sid, body="A restart interrupted it. Resuming where it left off.")
        try:
            if notices.telegram_ok("resumed"):
                notify(t["chat_id"],
                       "🔄 A restart interrupted this session — resuming where it left off.", silent=True)
        except Exception:  # noqa: BLE001
            pass
    return count
