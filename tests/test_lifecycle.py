"""Session lifecycle: done / abandoned / backlog, and the invariant that
`archived` stays the derived 'hidden' flag every existing query filters on."""

from bridge import store
from bridge.dashboard import server as dash

store.init()
CHAT = 555


def _session(project="/lifecycle"):
    return store.create_session(CHAT, project)["id"]


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    return h, box


def _row(sid):
    return store.get_session(sid)


def test_fresh_session_is_active():
    r = _row(_session())
    assert r["lifecycle"] is None and r["archived"] == 0


def test_each_state_hides_the_session():
    """done/abandoned/backlog all mean 'not in the active list' — archived is how
    every existing query already expresses that, so it must follow."""
    for state in store.LIFECYCLES:
        sid = _session()
        store.set_lifecycle(sid, state)
        r = _row(sid)
        assert r["lifecycle"] == state
        assert r["archived"] == 1, f"{state} must hide the session"


def test_clearing_lifecycle_revives_the_session():
    sid = _session()
    store.set_lifecycle(sid, "done")
    store.set_lifecycle(sid, None)
    r = _row(sid)
    assert r["lifecycle"] is None and r["archived"] == 0


def test_hidden_sessions_drop_out_of_the_active_list():
    proj = "/lifecycle-list"
    keep, gone = _session(proj), _session(proj)
    store.set_lifecycle(gone, "abandoned")
    ids = {s["id"] for s in store.list_sessions(CHAT, proj)}
    assert keep in ids and gone not in ids
    ids_all = {s["id"] for s in store.list_sessions(CHAT, proj, include_archived=True)}
    assert gone in ids_all


def test_archive_still_works_and_states_a_reason():
    """The old boolean setter has callers; archiving with no reason reads as done
    rather than leaving lifecycle NULL while archived=1."""
    sid = _session()
    store.archive(sid)
    r = _row(sid)
    assert r["archived"] == 1 and r["lifecycle"] == "done"


def test_archive_does_not_overwrite_a_stated_reason():
    sid = _session()
    store.set_lifecycle(sid, "backlog")
    store.archive(sid)
    assert _row(sid)["lifecycle"] == "backlog"   # COALESCE keeps the real reason


def test_unarchive_clears_the_reason():
    sid = _session()
    store.set_lifecycle(sid, "abandoned")
    store.archive(sid, False)
    r = _row(sid)
    assert r["archived"] == 0 and r["lifecycle"] is None


def test_history_carries_the_reason_so_backlog_is_findable():
    """Without this, backlog and done are indistinguishable once hidden — which
    would make 'not now' the same as 'finished'."""
    sid = _session("/lifecycle-hist")
    store.set_lifecycle(sid, "backlog")
    row = next(r for r in store.history(CHAT, include_archived=True)
               if r["id"] == sid)
    assert row["lifecycle"] == "backlog"


# --- endpoint ----------------------------------------------------------------

def test_endpoint_sets_and_clears():
    sid = _session()
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/lifecycle", {"lifecycle": "backlog"})  # noqa: SLF001
    assert box["code"] == 200 and box["obj"]["lifecycle"] == "backlog"
    assert _row(sid)["archived"] == 1

    h._post_api(f"/local/sessions/{sid}/lifecycle", {"lifecycle": None})       # noqa: SLF001
    assert box["obj"]["lifecycle"] is None
    assert _row(sid)["archived"] == 0


def test_endpoint_rejects_an_unknown_state():
    sid = _session()
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/lifecycle", {"lifecycle": "sorta-done"})  # noqa: SLF001
    assert box["code"] == 400
    assert _row(sid)["lifecycle"] is None


def test_endpoint_refuses_another_chats_session():
    sid = store.create_session(999, "/notyours")["id"]
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/lifecycle", {"lifecycle": "done"})     # noqa: SLF001
    assert box["code"] == 404
    assert _row(sid)["lifecycle"] is None
