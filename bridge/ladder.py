"""What happens when a turn dies on a usage limit, beyond waiting for the reset.

limits.py parks the session — that already works and stays the safety net. This
module is the *choosing* half: it reads the session's fallback policy and offers
the rungs actually available right now,

  1. another Claude account   (accounts.pick — full fidelity, resumes the session)
  2. the next model down      (Auto-switch only: the turn died on a model's own
                               cap, "You've hit your Fable limit", and every
                               login in Auto-switch is out of that model)
  3. stay parked              (limits.py, always available, never removed)

The order at every limit-death site is park first, escalate second, so there is
never a moment where a session is neither parked nor running. Kept out of
limits.py deliberately: that module's job is waiting (two wait kinds, one timer,
one parking lot) and it must not import the modules this one composes.
"""

import json
import os
import sys

from bridge import accounts, config

POLICIES = ("ask", "auto", "wait")
DEFAULT_POLICY = "ask"


# The default for sessions that have no policy of their own. Settable from the
# dashboard's Accounts tab and persisted next to the DB, so it survives a
# restart; absent, config.FALLBACK_POLICY (the env setting) still decides.
_cache: "str | None" = None


def _default_path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "fallback_policy.json")


def default_policy() -> str:
    """The policy a session with no setting of its own gets."""
    global _cache
    if _cache is None:
        try:
            with open(_default_path()) as f:
                _cache = (json.load(f) or {}).get("policy")
        except (OSError, ValueError):
            _cache = ""
    if _cache in POLICIES:
        return _cache
    env = getattr(config, "FALLBACK_POLICY", DEFAULT_POLICY)
    return env if env in POLICIES else DEFAULT_POLICY


def set_default_policy(policy: "str | None") -> str:
    """Persist the global default; None clears it back to the env setting."""
    global _cache
    if policy is not None and policy not in POLICIES:
        raise ValueError(f"policy must be one of {POLICIES}")
    _cache = policy or ""
    try:
        os.makedirs(os.path.dirname(_default_path()), exist_ok=True)
        with open(_default_path(), "w") as f:
            json.dump({"policy": policy}, f)
    except OSError as e:
        print(f"[ladder] persist failed: {e}", file=sys.stderr)
    return default_policy()


def policy_for(session: "dict | None") -> str:
    """This session's policy, falling back to the configured default. An
    unrecognized stored value reads as the default rather than disabling the
    ladder silently."""
    p = (session or {}).get("fallback_policy")
    return p if p in POLICIES else default_policy()


def resolve_agent(spec: str) -> tuple:
    """A hand-picked rung -> (account_slot, runtime) for start_streaming_job.

    Same vocabulary the ladder already stores on a turn ('claude:<slot>'), so a
    turn you routed yourself and one the ladder handed off read identically in
    the transcript. "" = the ambient login.

    Raises ValueError when the pick is not live any more (account removed or
    disabled) -- better a 400 than silently running the turn on somebody
    else's account.
    """
    kind, _, arg = (spec or "").strip().partition(":")
    if not kind:
        return None, None
    if kind == "claude":
        slot = int(arg) if arg.isdigit() else -1
        if not any(a["slot"] == slot and not a["disabled"]
                   for a in accounts.list_accounts()):
            raise ValueError(f"no usable account in slot {arg!r}")
        return slot, None
    raise ValueError(f"unknown agent {spec!r}")


def same_agent(runtime: "str | None") -> tuple:
    """A turn's stored runtime -> the (account_slot, runtime) that reruns it on
    the same login. Resuming an interrupted turn must land where it was running:
    without this it silently falls back to the ambient account, which is how a
    session handed to account 2 ends up back on the exhausted account 1.

    Unlike resolve_agent this never raises — a resume whose account has since
    been removed degrades to the ambient login instead of not happening."""
    try:
        return resolve_agent(runtime or "")
    except ValueError:
        return None, None


def rungs(session: "dict | None", dead_slot: "int | None" = None,
          auto_switch: bool = False, model: "str | None" = None) -> list:
    """Alternatives to waiting, first choice first (accounts.pick follows the
    Auto-switch order). Waiting itself is always available and is not listed
    here -- the caller offers it alongside these. With auto_switch, only
    accounts still in Auto-switch: those it may move to without asking. With model, only accounts with room left for it."""
    out = []
    slot = accounts.pick(exclude=(dead_slot,) if dead_slot else (),
                         auto_switch=auto_switch, model=model)
    if slot:
        left = accounts.headroom(slot)
        room = f" ({left}% left)" if left is not None else ""
        out.append({"kind": "account", "slot": slot,
                    "label": f"Account {slot}{room}"})
    return out


def escalate(session: dict, chat_id: int, *, dead_slot: "int | None" = None,
             model=None, effort=None, out_of: "str | None" = None,
             run=None, notify=None) -> "dict | None":
    """Consulted right after limits.defer() parked the session. Returns the rung
    that took the work (and the park is cancelled), or None when the park stands.

    out_of is the model whose own cap the turn died on (limits.limit_model).
    A login out of it is no rung: handing the work there, on that model, only
    dies again, and two such logins used to pass it back and forth for good.

    run/notify are injectable for tests; both default to the real ones.
    """
    policy = policy_for(session)
    if policy == "wait":
        return None
    available = rungs(session, dead_slot=dead_slot, auto_switch=policy == "auto", model=out_of)
    if policy == "auto" and not available and out_of in config.MODELS_LOW_TO_HIGH[1:]:
        # Every login in Auto-switch is out of that model: the next model down, on
        # any of them, the one it died on too (only that model ran out there).
        lower = config.MODELS_LOW_TO_HIGH[config.MODELS_LOW_TO_HIGH.index(out_of) - 1]
        available = [{**r, "model": lower, "label": f"{lower.capitalize()}, {r['label']}"}
                     for r in rungs(session, auto_switch=True, model=lower)]
    why = None
    if policy == "auto" and not available:
        # Only accounts you kept out of Auto-switch may have room: ask instead.
        available = rungs(session, dead_slot=dead_slot, model=out_of)
        if available:
            policy = "ask"
            # The label says how much room only when its meter reads (pick's last resort may not).
            why = f"No account in Auto-switch has room, and {available[0]['label']} is kept out of it."
    if not available:
        return None                       # nothing to offer: the park is the answer
    if run is None:
        from bridge import runner
        run = runner.start_streaming_job
    if notify is None:
        from bridge import telegram
        notify = telegram.send
    if policy == "ask":
        _offer(session, chat_id, available, notify, why=why, model=model, effort=effort)
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
MODEL_NUDGE = (
    "⏮ Your previous turn was cut off because the Claude usage limit was "
    "reached — not by the user. It has been resumed on another model. Review "
    "your recent transcript and continue exactly where you left off; finish the "
    "task you were doing. Don't start over.")

def _offer(session: dict, chat_id: int, available: list, notify, why=None,
           model=None, effort=None) -> None:
    """Post the card. The session stays parked behind it, so an unanswered card
    degrades into today's wait-for-reset rather than a stalled session. `why`
    says why it asks when Auto-switch was the policy, on every surface."""
    sid = session["id"]
    rows = []
    for r in available:
        if r["kind"] == "account":
            rows.append([{"text": f"↪ Switch to {r['label']}",
                          "callback_data": f"fb:a:{sid}:{r['slot']}"}])
    rows.append([{"text": "⏳ Wait for reset", "callback_data": f"fb:w:{sid}"}])
    from bridge import limits, notices
    offered = [{"slot": r["slot"], "label": r["label"]}
               for r in available if r["kind"] == "account"]
    # The chat asks too (the dashboard's YOUR CALL card), off the parked status.
    limits.offer(sid, offered, why)
    because = f" {why}" if why else ""
    notices.emit("limit_choice", sid, body=f"Usage limit reached.{because} Switch to another account, "
                                           "or wait for the reset.",
                 meta={"rungs": offered})
    if notices.telegram_ok("limit_choice"):
        from bridge import tgboard
        text = (f"⛔ Usage limit reached.{because} This chat is parked until the "
                "window resets — or something else can pick the work up now:")
        if not tgboard.limit_card(chat_id, sid, text, {"inline_keyboard": rows}):
            notify(chat_id, text, {"inline_keyboard": rows})


def take(session: dict, chat_id: int, rung: dict, *, run=None, notify=None,
         model=None, effort=None) -> "dict | None":
    """Hand the work to one rung and unpark the session. Returns the rung, or
    None when the handover could not be started (the park then stands)."""
    from bridge import limits
    if rung.get("kind") != "account":
        return None            # nothing else is on offer any more (a stale card)
    if run is None:
        from bridge import runner
        run = runner.start_streaming_job
    if notify is None:
        from bridge import telegram
        notify = telegram.send
    lower = rung.get("model")
    kw = {"project": session.get("cwd"), "session_id": session["id"],
          "model": lower or model, "effort": effort, "account_slot": rung["slot"]}
    try:
        job = run(chat_id, MODEL_NUDGE if lower else ACCOUNT_NUDGE, [], **kw)
    except Exception as e:  # noqa: BLE001
        print(f"[ladder] account handover failed: {e}", file=sys.stderr)
        return None
    if job is None:
        return None          # session already running: the user moved on
    if lower:
        # It stays on that model, as a moved session stays on its new login
        # (profiles.follow_account): its next turn would die on the old one.
        from bridge import profiles, store
        profiles.save_pick(store.get_session(session["id"]) or session, "model", lower)
    limits.cancel(session["id"])
    from bridge import notices
    notices.emit("resumed", session["id"], body=f"Continuing on {rung['label']}.")
    try:
        if notices.telegram_ok("resumed"):
            notify(chat_id, f"↪ Continuing on {rung['label']}.", silent=True)
    except Exception:  # noqa: BLE001
        pass
    return rung
