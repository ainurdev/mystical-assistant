"""The outcome taxonomy: what a failed turn is told to say for itself.

The counts in the names come from classifying every error turn in the real store
on 2026-09-12 — see the module docstring. `delivered` and `interrupted` are the
two that matter most: together they are 199 of 384 failures, and both mean "the
status is wrong, not the work".
"""

from bridge import outcomes


def _turn(status="error", elapsed=5, cost=0.1):
    return {"id": "t1", "status": status, "elapsed": elapsed, "cost": cost}


def _sig(**kw):
    base = {"errors": [], "has_text": False, "stopped": False,
            "has_result": False, "result_empty": False, "result_text": ""}
    base.update(kw)
    return base


def test_healthy_turn_has_no_outcome():
    assert outcomes.outcome(_turn(status="done"), _sig(has_text=True)) is None


def test_running_turn_has_no_outcome():
    assert outcomes.outcome(_turn(status="running"), _sig()) is None


def test_a_complete_result_that_still_says_error():
    """17 real turns. The answer is there; only the status is broken."""
    o = outcomes.outcome(_turn(elapsed=210, cost=6.23),
                         _sig(has_text=True, has_result=True, result_empty=False,
                              result_text="Here is the refactor, all tests pass."))
    assert o["code"] == "delivered"
    assert "re-sending" in o["detail"]


def test_a_failure_that_rode_the_result_string_is_not_delivered():
    """130 real turns: the result string IS the error. Calling that a delivered
    answer tells the user not to re-send a turn that never ran."""
    for text, code in (
            ("API Error: Server is temporarily limiting requests "
             "(not your usage limit) \u00b7 Rate limited", "overloaded"),
            ("Failed to authenticate. API Error: 401 Invalid credentials", "auth"),
            ("API Error: Connection lost mid-response.", "crashed")):
        o = outcomes.outcome(_turn(), _sig(has_text=True, has_result=True,
                                           result_text=text))
        assert o["code"] == code, text
        # Not echoed: the result panel above the badge already shows this text.
        assert not o["detail"].startswith(text[:20])
        assert o["detail"]


def test_a_long_answer_that_merely_mentions_an_error_is_still_delivered():
    answer = ("I looked into it. " * 40) + "the API Error you saw was a 529."
    o = outcomes.outcome(_turn(), _sig(has_text=True, has_result=True,
                                       result_text=answer[:300]))
    assert o["code"] == "delivered"


def test_no_result_and_no_message_is_the_orphan_flip():
    """52 real turns: claim_orphaned_turns flipped them at boot, silently."""
    o = outcomes.outcome(_turn(), _sig(has_text=True))
    assert o["code"] == "interrupted"


def test_both_timeout_strings_read_as_a_timeout():
    """The streaming watchdog and a blocking one-shot word it differently."""
    for msg in ("⏱️ No output for 30 min — killed as hung.",
                "⏱️ Timed out after 30 min."):
        o = outcomes.outcome(_turn(), _sig(errors=[msg], has_text=True))
        assert o["code"] == "timeout", msg


def test_long_healthy_turn_is_not_a_timeout():
    """RUN_TIMEOUT is a silence watchdog, so elapsed must never imply a timeout."""
    o = outcomes.outcome(_turn(elapsed=99_999, cost=15.15),
                         _sig(has_text=True, has_result=True))
    assert o["code"] == "delivered"


def test_restart_kill():
    o = outcomes.outcome(_turn(), _sig(errors=["claude exited -9"], has_text=True))
    assert o["code"] == "restarted"


def test_missing_binary_reads_as_auth():
    o = outcomes.outcome(_turn(), _sig(errors=["`claude` not found on PATH."]))
    assert o["code"] == "auth"


def test_usage_limit_and_server_error_use_the_limits_classifiers():
    limit = outcomes.outcome(_turn(), _sig(errors=["Claude usage limit reached"]))
    assert limit["code"] == "limit"
    over = outcomes.outcome(_turn(), _sig(errors=["API Error: 529 overloaded_error"]))
    assert over["code"] == "overloaded"


def test_an_unrecognised_error_event_still_shows_its_message():
    """An `error` event is not rendered anywhere else, so the badge carries it."""
    o = outcomes.outcome(_turn(), _sig(errors=["boom: the thing broke"]))
    assert o["code"] == "crashed"
    assert "boom" in o["detail"]


def test_old_cli_rejected_by_the_api_reads_as_outdated_not_out_of_context():
    """2026-09-22, verbatim. It starts "Prompt is too long", so it used to be
    labelled OUT OF CONTEXT, which says to compact, and compacting is the call
    the API rejected. What fixes it is `claude update`."""
    text = ("Prompt is too long · automatic compaction failed: API Error: 400 "
            "Claude Code 2.1.263 does not support this model; version 2.1.280 or "
            "newer is required. Run 'claude update', or update the Claude desktop "
            "app, then try again.")
    o = outcomes.outcome(_turn(elapsed=3, cost=0),
                         _sig(has_text=True, has_result=True, result_text=text))
    assert o["code"] == "outdated"


def test_stopped_by_the_user_is_not_a_failure_to_explain():
    o = outcomes.outcome(_turn(), _sig(stopped=True, has_text=True))
    assert o["code"] == "stopped"


def test_blank_result_after_real_talking():
    """57 real turns: partial work, no answer."""
    o = outcomes.outcome(_turn(elapsed=210, cost=6.23),
                         _sig(has_text=True, has_result=True, result_empty=True))
    assert o["code"] == "empty"


def test_died_before_saying_anything():
    """19 real turns: blank result, never spoke, nothing spent."""
    o = outcomes.outcome(_turn(elapsed=0, cost=0),
                         _sig(has_result=True, result_empty=True))
    assert o["code"] == "silent"


def test_every_error_turn_gets_a_label():
    """Whatever the shape, an error turn never renders blank again."""
    for sig in (_sig(), _sig(has_text=True), _sig(errors=["odd"]),
                _sig(has_result=True, result_empty=True),
                _sig(has_result=True, result_empty=True, has_text=True),
                _sig(stopped=True), _sig(errors=[""], has_result=True)):
        o = outcomes.outcome(_turn(), sig)
        assert o and o["code"] and o["label"] and o["detail"]
