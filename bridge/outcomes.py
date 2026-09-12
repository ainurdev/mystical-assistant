"""Why did that turn end like that?

`turns.status` has three values — running, done, error — and `store.finish_turn`
has nowhere to write a reason, so 275 of the 384 error turns in the real store say
nothing at all about themselves. The UI renders a red row and the user is left to
guess whether to re-send the prompt, wait out a limit, or go read the transcript.

Derived, never stored. Every input is already on the row or in its events, so one
pure function answers for turns recorded long before this module existed, and a
better rule tomorrow re-labels history instead of only new failures. No
migration, no backfill, nothing to keep in sync — and no switch in the AI tab,
because this spends nothing.

Counted over the real store on 2026-09-12, all 384 error turns:

   75  overloaded   an API 5xx / server-side 429
   57  empty        a blank final result after the agent had been talking
   52  interrupted  no result and no message — the signature of
                    `store.claim_orphaned_turns`, which flips a restart's
                    abandoned turns to error at boot. Not a failure of the work.
   51  crashed      an error message that is none of the known families
   45  timeout      the hang watchdog, or a blocking one-shot's own cap
   43  limit        the account's usage window
   17  delivered    a complete answer — and the row went error anyway. Nothing
                    to re-send; the status is the only broken thing.
   12  failed / 12 restarted / 10 auth / 7 silent / 3 context

Only 109 of those carried an `error` event. The rest are read off the shape of
the turn, and the single biggest trap is the result string: a dropped
connection, a 429 or an expired login is handed back *as the turn's result*, so
130 of the 147 non-blank results read as a delivered answer until you read what
that answer actually says.
Getting that wrong is not cosmetic — it tells the user not to re-send a turn
that never ran.

Reading the message beats inferring from the row, so the message tests run first;
`elapsed` is deliberately not one of them, because RUN_TIMEOUT is a *silence*
watchdog (runner.py:1863) — a healthy turn can run for an hour, and a hang kill
announces itself in its own error message anyway.

Message classification is `bridge/limits.py`'s: it already reads Anthropic's error
text for the parked-session ladder, and a second set of regexes over the same
strings would drift from it. Stdlib only.
"""

from bridge import limits

# code -> (label, detail). The detail says what to DO, because naming a failure
# the user can't act on is just a prettier blank.
_SAYS = {
    "delivered": ("ANSWER DELIVERED",
                  "The full result arrived and the run failed after handing it "
                  "over. Read it above — nothing needs re-sending."),
    "interrupted": ("INTERRUPTED",
                    "A bridge restart cut this turn off mid-run. Recovery "
                    "resumes it on the next start; nothing was lost."),
    "timeout": ("KILLED AS HUNG",
                "No output for RUN_TIMEOUT, so the watchdog killed it. Whatever "
                "it had done is in the transcript."),
    "restarted": ("BRIDGE RESTARTED",
                  "The bridge restarted and took its Claude child with it "
                  "(exit -9). Not an out-of-memory kill."),
    "auth": ("COULD NOT START",
             "Claude never got going — the binary or the login. Check ACCOUNTS."),
    "limit": ("USAGE LIMIT",
              "The account hit its limit. A parked session resumes itself at the "
              "reset."),
    "overloaded": ("API OVERLOADED",
                   "Anthropic returned a 5xx. Re-sending usually works."),
    "context": ("OUT OF CONTEXT",
                "The conversation outgrew the window. Start a fresh session, or "
                "let autocompact take it."),
    "stopped": ("YOU STOPPED IT", "Stopped from a surface, not a failure."),
    "empty": ("NO ANSWER",
              "It was working and then handed back a blank result. The partial "
              "work is above; re-send if it never got to the point."),
    "silent": ("DIED SILENTLY",
               "The run ended before saying anything: no output, no message. "
               "Send the prompt again."),
    "crashed": ("CRASHED", "The run died with the error shown above."),
    "failed": ("FAILED", "Ended in an error with nothing to say for itself."),
}


# How a failure announces itself when it rides the result string. Short, because
# a real answer that merely mentions an API error is an answer, not a failure —
# 130 of the 147 non-blank results on failed turns are one of these one-liners.
_ERROR_HEAD = ("API Error", "Failed to authenticate", "❌", "⏱")


def _error_shaped(result: "str | None") -> str:
    """The result string, when the result string IS the error. The runner hands
    some deaths back as the turn's result rather than as an `error` event (a
    dropped connection, a server 429, an expired login), and reading those as a
    delivered answer is how you get told "nothing needs re-sending" about a turn
    that never ran."""
    r = (result or "").strip()
    if not r or len(r) > 300:
        return ""
    hit = (r.startswith(_ERROR_HEAD) or limits.is_limit_error(r)
           or limits.is_server_error(r) or limits.is_context_error(r)
           or limits.is_auth_error(r))
    return r if hit else ""


def outcome(turn: dict, signals: dict) -> "dict | None":
    """Name the way this turn ended, or None when there is nothing to explain.

    `signals` is what its events say, gathered by the caller (which holds the
    connection; this stays pure and testable):

      errors       `error`-event messages, in order
      has_text     the agent said something
      stopped      a `stopped` event — the user pressed stop
      has_result   a terminal `result` event arrived at all
      result_empty ...and its result string was blank
      result_text  ...and what it said, for the failures the runner writes into
                   the result instead of into an error event

    A non-error turn gets None: a green row needs no badge.
    """
    if turn.get("status") != "error":
        return None

    msg = next((m for m in (signals.get("errors") or []) if (m or "").strip()), "")
    # A message lifted out of the result string is already on screen in the
    # result panel, so the badge says what to do about it instead of repeating it
    # word for word underneath.
    on_screen = not msg
    if not msg:
        msg = _error_shaped(signals.get("result_text"))

    if msg:
        if "killed as hung" in msg or "Timed out after" in msg:
            # Two strings, one cause: the streaming watchdog says "killed as
            # hung" (runner.py:1901) and a blocking one-shot says "Timed out
            # after N min" (runner.py:449).
            code = "timeout"
        elif "exited -9" in msg:
            code = "restarted"
        elif limits.is_auth_error(msg) or "not found on PATH" in msg:
            code = "auth"
        elif limits.is_limit_error(msg):
            code = "limit"
        elif limits.is_server_error(msg):
            code = "overloaded"
        elif limits.is_context_error(msg):
            code = "context"
        else:
            code = "crashed"
    elif signals.get("stopped"):
        code = "stopped"
    elif not signals.get("has_result"):
        # No terminal event and nobody wrote a reason: the boot-time orphan flip
        # (store.claim_orphaned_turns). Saying "restart" here is a fact about the
        # bridge, not a guess about the work.
        code = "interrupted"
    elif not signals.get("result_empty"):
        code = "delivered"
    elif signals.get("has_text"):
        code = "empty"
    elif not (turn.get("elapsed") or turn.get("cost")):
        code = "silent"
    else:
        code = "failed"

    label, detail = _SAYS[code]
    # A message nobody else renders beats the canned line — it is the most
    # specific thing known about this failure. Trimmed: some are a stack trace.
    if msg.strip() and not on_screen:
        detail = msg.strip()[:400]
    return {"code": code, "label": label, "detail": detail}
