"""What a turn spent, as the runner counts it from the CLI's stream.

The stream repeats a message's usage on every content block, and that usage is
the message's as it started (output near zero); each `result` carries the exact
per-query sums. Checked against claude 2.1.3xx on 2026-11-08: a message with
thinking + tool_use came as two events with one usage; a woken turn's second
result covered only its own request.
"""

from bridge import runner, store

store.init()


def _usage(inp, out, cw, cr):
    return {"input_tokens": inp, "output_tokens": out,
            "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr}


def _block(job, mid, usage, kind="text"):
    runner._handle_event(job, {"type": "assistant", "message": {
        "id": mid, "usage": usage, "content": [{"type": kind, "text": "x", "thinking": "x"}]}})


def _result(job, usage):
    runner._handle_event(job, {"type": "result", "result": "ok", "usage": usage})


def test_a_message_split_into_blocks_counts_once():
    job = runner.Job("tt1", 555)
    _block(job, "m1", _usage(2, 5, 24098, 11382), "thinking")
    _block(job, "m1", _usage(2, 5, 24098, 11382), "tool_use")
    _block(job, "m2", _usage(2, 3, 490, 35480))
    assert job.tokens == {"in": 4, "out": 8, "cache_w": 24588, "cache_r": 46862}


def test_the_result_replaces_the_estimate_with_the_exact_spend():
    job = runner.Job("tt2", 555)
    _block(job, "m1", _usage(2, 5, 24098, 11382))
    _block(job, "m2", _usage(2, 3, 490, 35480))
    _result(job, _usage(4, 230, 24588, 46862))
    assert job.tokens == {"in": 4, "out": 230, "cache_w": 24588, "cache_r": 46862}


def test_a_woken_turns_results_add_up():
    job = runner.Job("tt3", 555)
    _block(job, "m1", _usage(2, 1, 19020, 11384))
    _result(job, _usage(2, 160, 19020, 11384))
    _block(job, "m2", _usage(2, 1, 5848, 30410))
    # Between the two results: the first's exact sums plus the new message's estimate.
    assert job.tokens == {"in": 4, "out": 161, "cache_w": 24868, "cache_r": 41794}
    _result(job, _usage(2, 3, 5848, 30410))
    assert job.tokens == {"in": 4, "out": 163, "cache_w": 24868, "cache_r": 41794}


def test_a_turn_that_never_reported_usage_stays_unknown():
    job = runner.Job("tt4", 555)
    _block(job, "m1", {})
    _result(job, None)
    assert job.tokens is None
