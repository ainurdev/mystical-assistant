"""What happens when a turn dies on a usage limit, beyond waiting for the reset.

limits.py parks the session — that already works and stays the safety net. This
module is the *choosing* half: it reads the session's fallback policy and offers
the rungs actually available right now,

  1. another Claude account   (accounts.pick — full fidelity, resumes the session)
  2. a free agent             (freeagent — different provider, fresh session)
  3. stay parked              (limits.py, always available, never removed)

The order at every limit-death site is park first, escalate second, so there is
never a moment where a session is neither parked nor running. Kept out of
limits.py deliberately: that module's job is waiting (two wait kinds, one timer,
one parking lot) and it must not import the modules this one composes.
"""

import sys

from bridge import accounts, config

POLICIES = ("ask", "auto", "wait")
DEFAULT_POLICY = "ask"


def policy_for(session: "dict | None") -> str:
    """This session's policy, falling back to the configured default. An
    unrecognized stored value reads as the default rather than disabling the
    ladder silently."""
    p = (session or {}).get("fallback_policy")
    if p in POLICIES:
        return p
    d = getattr(config, "FALLBACK_POLICY", DEFAULT_POLICY)
    return d if d in POLICIES else DEFAULT_POLICY


def _free_providers() -> list:
    """Free-agent providers that are configured and reachable, best first.
    Lazy import: freeagent probes for the opencode binary."""
    from bridge import freeagent
    return freeagent.available()


def rungs(session: "dict | None", dead_slot: "int | None" = None,
          strategy: str = "best") -> list:
    """Alternatives to waiting, best first. Waiting itself is always available
    and is not listed here -- the caller offers it alongside these."""
    out = []
    slot = accounts.pick(exclude=(dead_slot,) if dead_slot else (),
                         strategy=strategy)
    if slot:
        left = accounts.headroom(slot)
        room = f" ({left}% left)" if left is not None else ""
        out.append({"kind": "account", "slot": slot,
                    "label": f"Account {slot}{room}"})
    for p in _free_providers():
        out.append({"kind": "free", "provider": p["provider"],
                    "model": p.get("model"),
                    "label": f"Free agent ({p.get('label') or p['provider']})"})
    return out


def escalate(session: dict, chat_id: int, *, dead_slot: "int | None" = None,
             model=None, effort=None, run=None, notify=None) -> "dict | None":
    """Consulted right after limits.defer() parked the session. Returns the rung
    that took the work (and the park is cancelled), or None when the park stands.

    run/notify are injectable for tests; both default to the real ones.
    """
    policy = policy_for(session)
    if policy == "wait":
        return None
    available = rungs(session, dead_slot=dead_slot)
    if not available:
        return None                       # nothing to offer: the park is the answer
    if run is None:
        from bridge import runner
        run = runner.start_streaming_job
    if notify is None:
        from bridge import telegram
        notify = telegram.send
    if policy == "ask":
        _offer(session, chat_id, available, notify, model=model, effort=effort)
        return None
    return take(session, chat_id, available[0], run=run, notify=notify,
                model=model, effort=effort)


# Prompts for the turn that takes over. Same shape as limits.NUDGE: say plainly
# that the user did not stop the work, and forbid starting over.
ACCOUNT_NUDGE = (
    "⏮ Your previous turn was cut off because the Claude usage limit was "
    "reached — not by the user. It has been resumed on another account. Review "
    "your recent transcript and continue exactly where you left off; finish the "
    "task you were doing. Don't start over.")

def _handoff_prompt(session: dict) -> str:
    """The briefing a free agent takes over with. Built from the session's own
    stored prompts -- deliberately NOT an LLM summary, because the account that
    would write it is the one that just ran out of quota."""
    from bridge import freeagent, store
    try:
        recent = store.recent_prompts(session["id"], 4)   # newest first
    except Exception:  # noqa: BLE001
        recent = []
    task = recent[0] if recent else "(continue the work already in progress)"
    return freeagent.briefing(task, list(reversed(recent[1:])))


def _offer(session: dict, chat_id: int, available: list, notify,
           model=None, effort=None) -> None:
    """Post the card. The session stays parked behind it, so an unanswered card
    degrades into today's wait-for-reset rather than a stalled session."""
    sid = session["id"]
    rows = []
    for r in available:
        if r["kind"] == "account":
            rows.append([{"text": f"↪ Switch to {r['label']}",
                          "callback_data": f"fb:a:{sid}:{r['slot']}"}])
        else:
            rows.append([{"text": f"🆓 {r['label']}",
                          "callback_data": f"fb:f:{sid}:{r['provider']}"}])
    rows.append([{"text": "⏳ Wait for reset", "callback_data": f"fb:w:{sid}"}])
    notify(chat_id, "⛔ Usage limit reached. This chat is parked until the "
                    "window resets — or something else can pick the work up now:",
           {"inline_keyboard": rows})


def take(session: dict, chat_id: int, rung: dict, *, run=None, notify=None,
         model=None, effort=None) -> "dict | None":
    """Hand the work to one rung and unpark the session. Returns the rung, or
    None when the handover could not be started (the park then stands)."""
    from bridge import limits
    if run is None:
        from bridge import runner
        run = runner.start_streaming_job
    if notify is None:
        from bridge import telegram
        notify = telegram.send
    kw = {"project": session.get("cwd"), "session_id": session["id"],
          "model": model, "effort": effort}
    if rung["kind"] == "account":
        prompt, kw["account_slot"] = ACCOUNT_NUDGE, rung["slot"]
    else:
        prompt = _handoff_prompt(session)
        kw["runtime"] = f"opencode:{rung['provider']}"
    try:
        job = run(chat_id, prompt, [], **kw)
    except Exception as e:  # noqa: BLE001
        print(f"[ladder] {rung['kind']} handover failed: {e}", file=sys.stderr)
        return None
    if job is None:
        return None          # session already running: the user moved on
    limits.cancel(session["id"])
    try:
        notify(chat_id, f"↪ Continuing on {rung['label']}.")
    except Exception:  # noqa: BLE001
        pass
    return rung
