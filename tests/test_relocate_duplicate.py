"""Duplicating and relocating sessions.

The invariant worth guarding: a copy must never write into its source's claude
transcript, and a relocate must rewrite paths everywhere the model can see them
or the model notices the move.
"""

from bridge import store
from bridge.dashboard import server as dash

store.init()
CHAT = 555


def _seeded(cwd="/repo/main"):
    """A session with two turns and an event carrying a path in its payload.

    turns.id is a global primary key, so each seeded session mints its own —
    reusing 't1' across fixtures collides."""
    s = store.create_session(CHAT, "/dup", cwd=cwd)
    sid = s["id"]
    t1, t2 = f"{sid}-t1", f"{sid}-t2"
    store.set_claude_session_id(sid, "src-csid")
    store.import_transcript(
        sid,
        [{"id": t1, "seq": 1, "prompt": f"read {cwd}/app.py", "status": "done"},
         {"id": t2, "seq": 2, "prompt": "and again", "status": "done"}],
        [{"turn_id": t1, "seq": 1, "type": "text",
          "text": f"I opened {cwd}/app.py and {cwd}/util.py"}])
    return sid


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    return h, box


# --- duplicate ---------------------------------------------------------------

def test_duplicate_copies_turns_and_events():
    sid = _seeded()
    copy = store.duplicate(sid)
    t = store.transcript(copy["id"])
    assert [x["prompt"] for x in t["turns"]] == ["read /repo/main/app.py", "and again"]
    assert len(t["events"]) == 1


def test_duplicate_does_not_adopt_the_sources_claude_session():
    """The whole point: continuing a copy must not append to the original's
    transcript. The copy holds the source id as fork_from, not as its own."""
    sid = _seeded()
    copy = store.duplicate(sid)
    assert copy["claude_session_id"] is None
    assert copy["fork_from"] == "src-csid"
    assert store.get_session(sid)["claude_session_id"] == "src-csid"  # untouched


def test_duplicate_gives_turns_fresh_ids():
    sid = _seeded()
    copy = store.duplicate(sid)
    src_ids = {t["id"] for t in store.transcript(sid)["turns"]}
    copy_ids = {t["id"] for t in store.transcript(copy["id"])["turns"]}
    assert not (src_ids & copy_ids)


def test_duplicate_leaves_the_source_transcript_alone():
    sid = _seeded()
    before = store.transcript(sid)
    store.duplicate(sid)
    assert store.transcript(sid) == before


def test_duplicate_names_the_copy_and_keeps_the_name():
    sid = _seeded()
    store.rename(sid, "Original Work")
    copy = store.duplicate(sid)
    assert copy["title"] == "Original Work (copy)"
    # 'manual' or the auto-titler would rename the copy after its first turn.
    assert copy["title_source"] == "manual"


def test_duplicate_does_not_carry_the_goal():
    """A copy is a fresh line of work; two sessions looping on one objective
    would both nudge themselves toward it."""
    from bridge import goals
    sid = _seeded()
    goals.create(sid, "ship it")
    copy = store.duplicate(sid)
    assert goals.get(copy["id"]) is None
    assert goals.get(sid) is not None            # source keeps its goal


def test_duplicate_of_a_missing_session_is_none():
    assert store.duplicate("nope") is None


def test_setting_a_real_id_spends_the_pending_fork():
    """Otherwise every later run would re-fork off the original."""
    sid = _seeded()
    copy = store.duplicate(sid)
    store.set_claude_session_id(copy["id"], "new-csid")
    assert store.get_session(copy["id"])["fork_from"] is None


# --- relocate ----------------------------------------------------------------

def test_relocate_rewrites_paths_in_prompts_and_events():
    sid = _seeded("/repo/main")
    n = store.relocate(sid, "/repo/wt-feature")
    assert n >= 2                                 # the turn and the event
    t = store.transcript(sid)
    assert t["turns"][0]["prompt"] == "read /repo/wt-feature/app.py"
    blob = str(t["events"])
    assert "/repo/wt-feature/app.py" in blob and "/repo/main" not in blob


def test_relocate_retargets_the_session():
    sid = _seeded("/repo/main")
    store.relocate(sid, "/repo/wt-feature")
    assert store.get_session(sid)["cwd"] == "/repo/wt-feature"


def test_relocate_tolerates_a_trailing_slash():
    sid = _seeded("/repo/main")
    store.relocate(sid, "/repo/wt-feature/")
    assert store.get_session(sid)["cwd"] == "/repo/wt-feature"
    assert "/repo/wt-feature/app.py" in store.transcript(sid)["turns"][0]["prompt"]


def test_relocate_with_no_old_cwd_only_retargets():
    """An empty old path must not be substituted — REPLACE('', x) would splice
    the new path between every character of the transcript."""
    s = store.create_session(CHAT, "/dup")        # no cwd
    sid = s["id"]
    store.import_transcript(
        sid, [{"id": f"{sid}-t1", "seq": 1, "prompt": "hello there",
               "status": "done"}], [])
    assert store.relocate(sid, "/repo/wt") == 0
    assert store.transcript(sid)["turns"][0]["prompt"] == "hello there"
    assert store.get_session(sid)["cwd"] == "/repo/wt"


def test_relocating_to_the_same_place_is_a_noop():
    sid = _seeded("/repo/main")
    assert store.relocate(sid, "/repo/main") == 0
    assert store.transcript(sid)["turns"][0]["prompt"] == "read /repo/main/app.py"


def test_relocate_of_a_missing_session_is_zero():
    assert store.relocate("nope", "/repo/wt") == 0


# --- endpoints ---------------------------------------------------------------

def test_duplicate_endpoint_refuses_another_chats_session():
    sid = store.create_session(999, "/notyours")["id"]
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/duplicate", {})            # noqa: SLF001
    assert box["code"] == 404


def test_relocate_endpoint_refuses_another_chats_session():
    sid = store.create_session(999, "/notyours")["id"]
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/relocate", {"project": "x"})  # noqa: SLF001
    assert box["code"] == 404


def test_relocate_endpoint_rejects_a_path_outside_base():
    """Relocating is not a way to point a session outside BASE_PATH."""
    sid = _seeded()
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/relocate",                 # noqa: SLF001
                {"project": "../../etc"})
    assert box["code"] == 400
    assert store.get_session(sid)["cwd"] == "/repo/main"           # unmoved
