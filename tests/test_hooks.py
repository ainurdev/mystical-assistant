"""Inbound hook logic: summarising, signatures, and what receive() records.

Run: python -m pytest tests/test_hooks.py -v
"""

import hashlib
import hmac
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import hooks, store, telegram  # noqa: E402


@pytest.fixture(autouse=True)
def _no_telegram(monkeypatch):
    """_notify pushes to every allowed chat; conftest pins one, so without this
    the suite would try to reach the real Telegram API."""
    sent = []
    monkeypatch.setattr(telegram, "send", lambda chat, text, **kw: sent.append((chat, text)))
    store.init()
    return sent


def _sign(secret: str, raw: bytes) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


# --- summarize ---------------------------------------------------------------

def test_summarize_prefers_the_nested_headline_over_the_shallow_noise():
    # A GitHub issue payload: "action" sits at the top, the title one level down.
    # Breadth-first would take "action"; the key order is what saves it.
    title, url = hooks.summarize({
        "action": "opened",
        "issue": {"title": "Bridge drops events", "html_url": "https://gh/1"},
        "repository": {"name": "mystical-assistant"},
    })

    assert title == "Bridge drops events"
    assert url == "https://gh/1"


def test_summarize_reaches_one_level_down_when_the_top_has_nothing():
    title, _ = hooks.summarize({"data": {"event": {"title": "Deploy failed"}}})

    assert title == "Deploy failed"


def test_summarize_walks_into_lists():
    title, _ = hooks.summarize({"errors": [{"message": "boom"}]})

    assert title == "boom"


def test_summarize_gives_up_quietly_on_a_shape_it_cannot_read():
    assert hooks.summarize({"a": {"b": {"c": {"d": {"title": "too deep"}}}}}) == (None, None)
    assert hooks.summarize("just a string") == (None, None)
    assert hooks.summarize({"count": 3}) == (None, None)


def test_summarize_truncates_a_hostile_title():
    title, _ = hooks.summarize({"title": "x" * 5000})

    assert len(title) == hooks._TITLE_MAX


# --- signatures --------------------------------------------------------------

def test_a_correct_github_digest_verifies():
    raw = b'{"a":1}'

    assert hooks.verify_signature("s3cret", raw,
                                  {"X-Hub-Signature-256": "sha256=" + _sign("s3cret", raw)})


def test_a_bare_hex_sentry_digest_verifies():
    raw = b'{"a":1}'

    assert hooks.verify_signature("s3cret", raw,
                                  {"Sentry-Hook-Signature": _sign("s3cret", raw)})


def test_a_digest_over_different_bytes_fails():
    assert not hooks.verify_signature(
        "s3cret", b'{"a":2}', {"X-Hub-Signature-256": "sha256=" + _sign("s3cret", b'{"a":1}')})


def test_a_missing_signature_header_fails_rather_than_passes():
    """The whole point of setting a secret: absence must not be a free pass."""
    assert not hooks.verify_signature("s3cret", b'{"a":1}', {})


def test_the_github_prefix_is_required():
    raw = b'{"a":1}'

    assert not hooks.verify_signature("s3cret", raw,
                                      {"X-Hub-Signature-256": _sign("s3cret", raw)})


# --- receive -----------------------------------------------------------------

def test_receive_records_the_event_and_bumps_the_hook(_no_telegram):
    h = store.create_hook("ci", "ci")

    ev = hooks.receive(h["token"], b'{"title":"build red","url":"https://ci/9"}', {})

    assert ev["title"] == "build red"
    assert ev["url"] == "https://ci/9"
    row = store.get_hook(h["token"])
    assert row["hits"] == 1 and row["last_seen"]
    assert _no_telegram and "build red" in _no_telegram[0][1]


def test_receive_on_an_unknown_token_is_none_and_records_nothing():
    before = len(store.list_hook_events(200))

    assert hooks.receive("nope", b"{}", {}) is None
    assert len(store.list_hook_events(200)) == before


def test_a_signed_hook_rejects_an_unsigned_post():
    h = store.create_hook("gh", "github", secret="s3cret")

    assert hooks.receive(h["token"], b'{"title":"x"}', {}) is None
    assert store.get_hook(h["token"])["hits"] == 0


def test_a_signed_hook_accepts_a_correctly_signed_post():
    h = store.create_hook("gh", "github", secret="s3cret")
    raw = b'{"title":"x"}'

    ev = hooks.receive(h["token"], raw,
                       {"X-Hub-Signature-256": "sha256=" + _sign("s3cret", raw)})

    assert ev is not None and ev["title"] == "x"


def test_a_body_that_is_not_json_is_kept_as_an_excerpt():
    h = store.create_hook("odd", "generic")

    ev = hooks.receive(h["token"], b"<xml>not json</xml>", {})

    assert ev is not None
    assert "not json" in json.loads(ev["payload"])["_raw"]


def test_a_telegram_outage_does_not_fail_the_receive(monkeypatch):
    h = store.create_hook("ci", "ci")

    def boom(*a, **kw):
        raise RuntimeError("telegram down")
    monkeypatch.setattr(telegram, "send", boom)

    assert hooks.receive(h["token"], b'{"title":"still recorded"}', {}) is not None


# --- storage -----------------------------------------------------------------

def test_the_event_tail_is_trimmed(monkeypatch):
    monkeypatch.setattr(store, "HOOK_EVENTS_KEEP", 3)
    h = store.create_hook("chatty", "ci")

    for i in range(6):
        hooks.receive(h["token"], json.dumps({"title": f"e{i}"}).encode(), {})

    kept = [e["title"] for e in store.list_hook_events(200)]
    assert kept == ["e5", "e4", "e3"]


def test_list_hooks_reports_that_a_secret_exists_but_never_what_it_is():
    store.create_hook("signed", "github", secret="s3cret")

    row = [h for h in store.list_hooks() if h["label"] == "signed"][0]

    assert row["signed"] is True
    assert "secret" not in row


def test_deleting_a_hook_takes_its_events_with_it():
    h = store.create_hook("doomed", "ci")
    hooks.receive(h["token"], b'{"title":"orphan"}', {})

    assert store.delete_hook(h["token"]) == 1
    assert store.get_hook(h["token"]) is None
    assert not [e for e in store.list_hook_events(200) if e["token"] == h["token"]]
