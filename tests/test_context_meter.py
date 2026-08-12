"""The context meter and the --autocompact knob.

The meter's whole correctness rests on measuring the LAST request's window fill
rather than a turn's accumulated spend, so that distinction is what these pin.
"""

from bridge import runner, store
from bridge.miniapp.server import normalize_autocompact

store.init()


def _usage(inp, read, create):
    return {"input_tokens": inp, "cache_read_input_tokens": read,
            "cache_creation_input_tokens": create, "output_tokens": 999}


def test_ctx_is_input_plus_both_cache_halves():
    # Output tokens are not context: they're what came back, not what went in.
    assert runner._ctx_of(_usage(2, 75773, 1623)) == 77398
    assert runner._ctx_of({}) is None
    assert runner._ctx_of(None) is None


def test_last_message_wins_rather_than_accumulating():
    # A turn with tool use sends many requests; the window fill is the newest
    # one's, not their sum (which would read ~2x high here).
    job = runner.Job("j1", 555)
    for u in (_usage(10, 40000, 100), _usage(5, 52000, 300)):
        runner._handle_event(job, {"type": "assistant", "message": {
            "usage": u, "content": [{"type": "text", "text": "hi"}]}})
    assert job.ctx_tokens == 52305


def test_a_message_without_usage_leaves_the_last_reading_alone():
    job = runner.Job("j2", 555)
    runner._handle_event(job, {"type": "assistant", "message": {
        "usage": _usage(1, 30000, 0), "content": []}})
    runner._handle_event(job, {"type": "assistant", "message": {"content": []}})
    assert job.ctx_tokens == 30001


def test_autocompact_reaches_the_command_line():
    cmd = runner._base_cmd("hi", 555, stream=True, interactive=True,
                           autocompact="150000")
    assert cmd[cmd.index("--autocompact") + 1] == "150000"
    # Unset = no flag, so claude keeps its own default.
    assert "--autocompact" not in runner._base_cmd(
        "hi", 555, stream=True, interactive=True)
    # Internal one-shots (titler, commit message) are single-turn: no flag.
    assert "--autocompact" not in runner._base_cmd(
        "hi", 555, stream=False, skip_pack=True, autocompact="150000")


def test_normalize_autocompact_rejects_instead_of_coercing():
    assert normalize_autocompact("auto") == (True, "auto")
    assert normalize_autocompact("150000") == (True, "150000")
    assert normalize_autocompact("150k") == (True, "150000")   # digits for the CLI
    assert normalize_autocompact(None) == (True, None)
    assert normalize_autocompact("") == (True, None)
    # Out of the range the CLI accepts, and outright nonsense: rejected, so a
    # typo can't silently move the compaction point.
    assert normalize_autocompact("50000")[0] is False
    assert normalize_autocompact("2000000")[0] is False
    assert normalize_autocompact("soon")[0] is False


def _dash_handler():
    """Drive the dashboard handler without sockets (as test_toolset_endpoints does)."""
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_autocompact_endpoint_persists_rejects_and_guards_ownership():
    h, box = _dash_handler()
    s = store.create_session(555, "/ctx1")
    h._post_api(f"/local/sessions/{s['id']}/autocompact", {"autocompact": "150k"})
    assert box["code"] == 200
    assert store.get_autocompact(s["id"]) == "150000"

    h._post_api(f"/local/sessions/{s['id']}/autocompact", {"autocompact": "soon"})
    assert box["code"] == 400
    assert store.get_autocompact(s["id"]) == "150000"   # the bad value changed nothing

    # Someone else's session: 404, and no write.
    other = store.create_session(999, "/ctx2")
    h._post_api(f"/local/sessions/{other['id']}/autocompact", {"autocompact": "auto"})
    assert box["code"] == 404
    assert store.get_autocompact(other["id"]) is None


def test_the_miniapp_endpoint_validates_the_same_way():
    """Both panels reach the same column, so both have to reject the same input —
    a knob that only one surface guards is a knob with a hole in it."""
    from bridge.miniapp import server as mini
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    s = store.create_session(555, "/ctx3")
    h._api_session_autocompact(555, s["id"], {"autocompact": "auto"})
    assert box["code"] == 200 and store.get_autocompact(s["id"]) == "auto"
    h._api_session_autocompact(555, s["id"], {"autocompact": "9000"})
    assert box["code"] == 400 and store.get_autocompact(s["id"]) == "auto"


def test_session_round_trips_both_columns():
    s = store.create_session(555, "proj", origin="test")
    assert store.get_autocompact(s["id"]) is None
    store.set_autocompact(s["id"], "150000")
    store.set_ctx_tokens(s["id"], 77398)
    assert store.get_autocompact(s["id"]) == "150000"
    row = store.get_session(s["id"])
    assert row["ctx_tokens"] == 77398
