"""Goals: keep a session working on one objective until the model marks it done.

The model owns the verdict — it calls CreateGoal/UpdateGoal/GetGoal (see
goal_mcp.py) and the bridge only drives the loop: when a turn ends with a goal
still 'active', the next nudge goes on the session's own queue, so it inherits
the queue's pause, reorder and retry rather than growing a second scheduler.

MAX_ITER is the brake. A model that keeps working without ever calling
UpdateGoal would otherwise burn a 5-hour window unattended.
"""

import sys

MAX_ITER = 10

# The goal's states. 'active' is the only one that keeps the loop running.
ACTIVE, COMPLETE, BLOCKED = "active", "complete", "blocked"

_NUDGE = (
    "[goal] Your active objective is not yet marked complete:\n\n"
    "{objective}\n\n"
    "Continue working on it. When it is finished call UpdateGoal(state="
    "\"complete\"); if you are stuck and need the user, call UpdateGoal(state="
    "\"blocked\", note=\"<what you need>\"). Do not stop for anything else."
)


def get(session_id: str) -> dict | None:
    """This session's goal, or None."""
    from bridge import store        # local import: store<->goals at import time
    return store.get_goal(session_id)


def create(session_id: str, objective: str) -> dict:
    """Start (or replace) this session's goal. Resets the iteration count."""
    from bridge import store
    goal = {"objective": objective.strip(), "state": ACTIVE, "iter": 0}
    store.set_goal(session_id, goal)
    return goal


def mark(session_id: str, state: str, note: str = "") -> dict | None:
    """Move the goal to complete/blocked (or back to active). No-op with no goal."""
    from bridge import store
    goal = store.get_goal(session_id)
    if not goal:
        return None
    goal["state"] = state
    if note:
        goal["note"] = note
    store.set_goal(session_id, goal)
    return goal


def clear(session_id: str) -> None:
    from bridge import store
    store.set_goal(session_id, None)


def should_continue(goal: dict | None) -> bool:
    """True when a finished turn should be followed by another nudge."""
    if not goal or goal.get("state") != ACTIVE:
        return False
    return int(goal.get("iter") or 0) < MAX_ITER


def continue_after_turn(job, model=None, effort=None) -> bool:
    """Called once per finished turn. Enqueues the next goal nudge and returns
    True if it did. model/effort come from the run that just ended, so the loop
    keeps the posture the user picked. Best-effort: a goal must never break a run."""
    try:
        sid = job.store_session_id
        if not sid or job.status != "done" or job.interrupted:
            return False
        goal = get(sid)
        if not should_continue(goal):
            return False
        from bridge import queue_manager, store

        goal["iter"] = int(goal.get("iter") or 0) + 1
        store.set_goal(sid, goal)
        sess = store.get_session(sid) or {}
        text = _NUDGE.format(objective=goal["objective"])
        queue_manager.enqueue(
            sid, text=text, prompt=text, images=[], model=model,
            effort=effort, permission_mode=sess.get("permission_mode"),
            width=None, sel=[], surface="goal", chat_id=job.chat_id,
            project=sess.get("project") or "")
        return True
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[goals] continue failed: {e}", file=sys.stderr)
        return False
