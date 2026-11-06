"""Goals: keep a session working on one objective until the model marks it done.

The model owns the verdict — it calls CreateGoal/UpdateGoal/GetGoal (see
goal_mcp.py) and the bridge only drives the loop: when a turn ends with a goal
still 'active', the next nudge goes on the session's own queue, so it inherits
the queue's pause, reorder and retry rather than growing a second scheduler.

MAX_ITER is the brake. A model that keeps working without ever calling
UpdateGoal would otherwise burn a 5-hour window unattended.

What the surfaces need on top of the loop (design: .mystical/design-drafts/goals,
A · SHEET): a short `title` (the model's, else title_of() cuts the objective),
`since`/`at` (when it was set / got its verdict, so its turns can be told apart
and a verdict announced once), and `seen` (a met goal stops showing once you
prompt again). You steer it from any surface: set_by_user() is /goal on the
dashboard, the Mini App and the bot; a reply of yours re-arms a blocked goal
(on_user_turn); Keep going re-opens a met one (rearm + kick).

Not built: a per-goal cap (every goal gets MAX_ITER), and goals on agent
(ACP) sessions — they load no goals MCP, so they could never mark one done.
"""

import re
import sys
import time

MAX_ITER = 10

# The goal's states. 'active' is the only one that keeps the loop running.
ACTIVE, COMPLETE, BLOCKED = "active", "complete", "blocked"

# Its first line carries the count and the title: the model reads where it is,
# and the dashboard draws the prompt as a stamp from it (PromptBubble), not as
# words you wrote. Older nudges start with a bare "[goal]".
_NUDGE = (
    "[goal {n}/{max}] {title}\n"
    "Your active objective is not yet marked complete:\n\n"
    "{objective}\n\n"
    "Continue working on it. When it is finished call UpdateGoal(state="
    "\"complete\"); if you are stuck and need the user, call UpdateGoal(state="
    "\"blocked\", note=\"<what you need>\"). Do not stop for anything else."
)
# Prompts the bridge writes itself (a nudge, a council's fix prompt, a wait's
# wake-up, a resume): none of them is your answer to a blocked goal.
_BRIDGE_PROMPTS = ("[goal", "[council", "⧖", "⏮")


def get(session_id: str) -> dict | None:
    """This session's goal, or None."""
    from bridge import store        # local import: store<->goals at import time
    return store.get_goal(session_id)


def title_of(goal: dict) -> str:
    """The goal's short name: the model's title, else its objective up to the
    first colon or full stop, at most 60 characters."""
    if (goal.get("title") or "").strip():
        return goal["title"].strip()
    text = " ".join((goal.get("objective") or "").split())
    head = re.split(r"[:.](?:\s|$)", text, maxsplit=1)[0].strip() or text
    return head if len(head) <= 60 else head[:59].rstrip() + "…"


def brief(goal: dict | None) -> dict | None:
    """What a client gets: the stored goal with its title always filled in, so
    no surface keeps its own copy of title_of()'s rule. Never stored."""
    return {**goal, "title": title_of(goal)} if goal else None


def create(session_id: str, objective: str, title: str = "") -> dict:
    """Start (or replace) this session's goal. Resets the iteration count."""
    from bridge import store
    goal = {"objective": objective.strip(), "state": ACTIVE, "iter": 0, "since": time.time()}
    if title.strip():
        goal["title"] = " ".join(title.split())[:80]
    store.set_goal(session_id, goal)
    return goal


def edit(session_id: str, objective: str) -> dict | None:
    """Replace the objective and keep its state, count and start. The old
    title described the old objective, so it goes."""
    from bridge import store
    goal = store.get_goal(session_id)
    if not goal or not objective.strip():
        return None
    goal["objective"] = objective.strip()
    goal.pop("title", None)
    store.set_goal(session_id, goal)
    return goal


def mark(session_id: str, state: str, note: str = "") -> dict | None:
    """Move the goal to complete/blocked (or back to active). No-op with no goal."""
    from bridge import store
    goal = store.get_goal(session_id)
    if not goal:
        return None
    goal["state"] = state
    goal["at"] = time.time()
    goal.pop("seen", None)
    if note:
        goal["note"] = note
    store.set_goal(session_id, goal)
    return goal


def rearm(session_id: str) -> dict | None:
    """Back to work. From blocked (your reply answered it) the count carries
    on; Keep going on a met goal, or on one that used up MAX_ITER, gets a
    fresh MAX_ITER. Its verdict and note are spent either way."""
    from bridge import store
    goal = store.get_goal(session_id)
    if not goal:
        return None
    if goal.get("state") == COMPLETE or int(goal.get("iter") or 0) >= MAX_ITER:
        goal["iter"] = 0
    goal["state"] = ACTIVE
    for k in ("note", "at", "seen"):
        goal.pop(k, None)
    store.set_goal(session_id, goal)
    return goal


def clear(session_id: str) -> None:
    from bridge import store
    store.set_goal(session_id, None)


def set_by_user(session: dict, objective: str) -> "tuple[dict | None, str]":
    """/goal from any surface. An objective sets the goal and, when nothing is
    running, starts on it now — a goal you set should not wait for your next
    prompt. A blank one clears it. Returns (goal, why it was refused)."""
    from bridge import profiles
    objective = (objective or "").strip()[:2000]
    if not objective:
        clear(session["id"])                   # clearing one is always fine
        return None, ""
    refusal = profiles.claude_only_refusal(session, "goal")
    if refusal:
        return None, refusal
    goal = create(session["id"], objective)
    kick(session["id"])
    return get(session["id"]) or goal, ""


def on_user_turn(session_id: str, prompt: str) -> None:
    """A turn of yours is starting: it answers a blocked goal (back to work,
    so its end nudges again), and a met goal has now been seen. Best-effort."""
    if (prompt or "").startswith(_BRIDGE_PROMPTS):
        return
    try:
        goal = get(session_id)
        if not goal:
            return
        if goal.get("state") == BLOCKED:
            rearm(session_id)
        elif goal.get("state") == COMPLETE and not goal.get("seen"):
            from bridge import store
            goal["seen"] = True
            store.set_goal(session_id, goal)
    except Exception as e:  # noqa: BLE001 — never raise into a turn's start
        print(f"[goals] on_user_turn failed: {e}", file=sys.stderr)


def verdict(job) -> dict | None:
    """The goal, when this turn is the one that met or blocked it: the turn's
    end announces that instead of a plain DONE."""
    try:
        goal = get(job.store_session_id or "")
    except Exception:  # noqa: BLE001
        return None
    if goal and goal.get("state") in (COMPLETE, BLOCKED) and (goal.get("at") or 0) >= job.started:
        return goal
    return None


def should_continue(goal: dict | None) -> bool:
    """True when a finished turn should be followed by another nudge."""
    if not goal or goal.get("state") != ACTIVE:
        return False
    return int(goal.get("iter") or 0) < MAX_ITER


def _nudge(sid: str, goal: dict, chat_id, effort=None, runtime=None) -> None:
    """Count the next auto-turn and queue its prompt on the session's queue."""
    from bridge import queue_manager, store
    goal["iter"] = int(goal.get("iter") or 0) + 1
    store.set_goal(sid, goal)
    sess = store.get_session(sid) or {}
    text = _NUDGE.format(n=goal["iter"], max=MAX_ITER, title=title_of(goal),
                         objective=goal["objective"])
    if (runtime or "").startswith("acp:"):
        text = text.replace("UpdateGoal", "update_goal")   # the gateway's name for it
    queue_manager.enqueue(
        sid, text=text, prompt=text, images=[], model=None,
        effort=effort, permission_mode=None,
        width=None, sel=[], surface="goal",
        chat_id=chat_id if chat_id is not None else sess.get("chat_id"),
        project=sess.get("project") or "")


def kick(session_id: str) -> bool:
    """Start on an active goal now, for one set or re-opened while nothing
    runs. A turn that is running, or a prompt already queued, nudges when it
    ends instead — kicking then would queue a second nudge behind it."""
    try:
        from bridge import queue_manager, state
        goal = get(session_id)
        if not should_continue(goal) or state.is_running(session_id):
            return False
        items = queue_manager.snapshot(session_id).get("items") or []
        if any(i.get("status") in ("queued", "running") for i in items):
            return False
        _nudge(session_id, goal, None)
        return True
    except Exception as e:  # noqa: BLE001 — a goal must never break a request
        print(f"[goals] kick failed: {e}", file=sys.stderr)
        return False


def continue_after_turn(job, effort=None) -> bool:
    """Called once per finished turn. Enqueues the next goal nudge and returns
    True if it did. Effort comes from the run that just ended (it is the
    device's, not the session's); model and mode are left to the session, read
    when the nudge starts, like any queued prompt — a pick made while it waits
    applies. Best-effort: a goal must never break a run."""
    try:
        sid = job.store_session_id
        if not sid or job.status != "done" or job.interrupted:
            return False
        from bridge import experimental
        if (job.runtime or "").startswith("acp:") and not experimental.enabled():
            return False              # no goals MCP on an agent: it could never mark the goal done
        from bridge import waits
        if waits.waiting(sid):        # it waits on another session; its wake-up is the next turn
            return False
        goal = get(sid)
        if not should_continue(goal):
            return False
        _nudge(sid, goal, job.chat_id, effort, job.runtime)
        return True
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[goals] continue failed: {e}", file=sys.stderr)
        return False
