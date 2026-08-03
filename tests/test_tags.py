"""Session tags: normalization, the titler's JSON reply, and the manual endpoint.

The titler drift-tolerance tests matter most — tagging was folded into the call
that already names sessions, so a parse regression would silently stop titling.
"""

from bridge import store, titler
from bridge.dashboard import server as dash

store.init()
CHAT = 555


def _session():
    return store.create_session(CHAT, "/tags")["id"]


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    return h, box


# --- normalization -----------------------------------------------------------

def test_clean_tags_lowercases_trims_and_strips_hashes():
    assert store.clean_tags(["  Auth ", "#Tests", "RE  FACTOR"]) == [
        "auth", "tests", "re factor"]


def test_clean_tags_dedupes_case_insensitively():
    assert store.clean_tags(["Auth", "auth", "AUTH"]) == ["auth"]


def test_clean_tags_caps_the_count():
    many = [f"t{i}" for i in range(20)]
    assert len(store.clean_tags(many)) == store.MAX_TAGS


def test_clean_tags_survives_junk():
    assert store.clean_tags(None) == []
    assert store.clean_tags("notalist") == []
    # Non-strings are coerced, not dropped mid-list; the contract is that every
    # element out is a non-empty str.
    out = store.clean_tags([1, None, {}, "ok"])
    assert all(isinstance(t, str) and t for t in out)
    assert "ok" in out


def test_set_and_get_roundtrip():
    sid = _session()
    assert store.set_tags(sid, ["Auth", "tests"]) == ["auth", "tests"]
    assert store.get_tags(sid) == ["auth", "tests"]


def test_empty_tags_clear_the_column():
    sid = _session()
    store.set_tags(sid, ["auth"])
    assert store.set_tags(sid, []) == []
    assert store.get_tags(sid) == []


def test_corrupt_tag_json_reads_as_untagged():
    sid = _session()
    with store._connect() as c:                    # noqa: SLF001 — corrupt on purpose
        c.execute("UPDATE sessions SET tags=? WHERE id=?", ("{{{", sid))
    assert store.get_tags(sid) == []


# --- the titler's reply parsing ---------------------------------------------

def test_parses_a_clean_json_reply():
    title, tags = titler._parse('{"title": "Fix The Auth Bug", '   # noqa: SLF001
                                '"tags": ["auth", "bugfix"]}')
    assert title == "Fix The Auth Bug"
    assert tags == ["auth", "bugfix"]


def test_parses_a_fenced_json_reply():
    title, tags = titler._parse(                    # noqa: SLF001
        '```json\n{"title": "Add Retry Logic", "tags": ["perf"]}\n```')
    assert title == "Add Retry Logic" and tags == ["perf"]


def test_parses_json_with_surrounding_chatter():
    """Small models prepend 'Here you go:' — take the object, not the sentence."""
    title, tags = titler._parse(                    # noqa: SLF001
        'Sure! Here is the JSON:\n{"title": "Rename The Store", "tags": ["refactor"]}')
    assert title == "Rename The Store" and tags == ["refactor"]


def test_a_bare_title_still_titles():
    """The pre-tagging behaviour is the fallback — adding tags must not be able
    to regress titling when the model ignores the JSON instruction."""
    title, tags = titler._parse("Fix The Auth Bug")   # noqa: SLF001
    assert title == "Fix The Auth Bug" and tags == []


def test_a_sentence_reply_is_still_rejected():
    """The >6-word guard catches a model that answered instead of naming."""
    title, _ = titler._parse(                        # noqa: SLF001
        "Your message got cut off there — could you say what you meant?")
    assert title == ""


def test_a_sentence_title_in_json_is_rejected_but_tags_survive():
    title, tags = titler._parse(                     # noqa: SLF001
        '{"title": "I am afraid I cannot name this conversation for you", '
        '"tags": ["misc"]}')
    assert title == ""
    assert tags == ["misc"]


def test_missing_tags_key_is_fine():
    title, tags = titler._parse('{"title": "Just A Title"}')   # noqa: SLF001
    assert title == "Just A Title" and tags == []


# --- endpoint ----------------------------------------------------------------

def test_endpoint_sets_normalized_tags():
    sid = _session()
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/tags", {"tags": ["  Auth", "#UI"]})  # noqa: SLF001
    assert box["code"] == 200 and box["obj"]["tags"] == ["auth", "ui"]
    assert store.get_tags(sid) == ["auth", "ui"]


def test_endpoint_rejects_a_non_list():
    sid = _session()
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/tags", {"tags": "auth"})   # noqa: SLF001
    assert box["code"] == 400


def test_endpoint_refuses_another_chats_session():
    sid = store.create_session(999, "/notyours")["id"]
    h, box = _handler()
    h._post_api(f"/local/sessions/{sid}/tags", {"tags": ["x"]})    # noqa: SLF001
    assert box["code"] == 404
    assert store.get_tags(sid) == []


def test_brief_exposes_tags():
    from bridge.miniapp.server import _session_brief               # noqa: SLF001
    sid = _session()
    store.set_tags(sid, ["auth"])
    assert _session_brief(store.get_session(sid))["tags"] == ["auth"]
