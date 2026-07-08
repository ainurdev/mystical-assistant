"""Startup recovery: resume turns a restart interrupted.

When the bridge is stopped/restarted mid-turn its Claude child dies with it and
the turn is left 'running' (the runner skips finish_turn once state.shutting_down
is set). On the next start we claim those orphaned turns and, for each resumable
one, resume its Claude session (--resume) with a short "you were interrupted,
continue" nudge. No cooldown: every boot-resume traces to a human restarting the
bridge, so it cannot self-loop — the crash-loop cap for resumes that keep dying
lives in the runner's mid-run auto-resume (runner.AUTO_RESUME_MAX).
"""

import sys

from bridge import config, runner, store, telegram

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
        if not t["claude_session_id"]:
            continue                                  # died before init — nothing to resume
        if t["chat_id"] not in config.ALLOWED_CHAT_IDS:
            continue
        resumed_sessions.add(sid)
        try:
            job = run(t["chat_id"], NUDGE, [], project=t["cwd"],
                      session_id=sid, model=t["model"])
        except Exception as e:  # noqa: BLE001
            print(f"[recovery] resume failed for {sid}: {e}", file=sys.stderr)
            continue
        if job is None:
            continue                                  # session busy (shouldn't happen at boot)
        count += 1
        try:
            notify(t["chat_id"],
                   "🔄 A restart interrupted this session — resuming where it left off.")
        except Exception:  # noqa: BLE001
            pass
    return count
