"""The two routes inbound hooks add: the public receiver on the Mini App server
and the dashboard's mint/revoke panel API. Driven without sockets via the
Handler.__new__ trick (mirrors test_breakdown_endpoint.py).

Run: python -m pytest tests/test_hooks_endpoint.py -v
"""

import hashlib
import hmac
import io
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import hooks, store, telegram  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402


@pytest.fixture(autouse=True)
def _no_telegram(monkeypatch):
    monkeypatch.setattr(telegram, "send", lambda chat, text, **kw: None)
    store.init()


def _mini(body: bytes, headers: "dict | None" = None):
    """A Mini App handler primed with a request body, bypassing the socket."""
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h.rfile = io.BytesIO(body)
    h.headers = dict(headers or {})
    h.headers.setdefault("Content-Length", str(len(body)))
    return h, box


def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _sign(secret: str, raw: bytes) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


# --- the public receiver -----------------------------------------------------

def test_a_valid_post_is_accepted_with_no_telegram_init_data():
    """The reason the route lives outside /api/*: GitHub cannot sign initData."""
    hook = store.create_hook("ci", "ci")
    raw = b'{"title":"build red"}'
    h, box = _mini(raw)

    h._hook(hook["token"])

    assert box["code"] == 200 and box["obj"]["ok"] is True
    assert store.get_hook(hook["token"])["hits"] == 1


def test_an_unknown_token_is_404():
    h, box = _mini(b"{}")

    h._hook("not-a-real-token")

    assert box["code"] == 404


def test_a_signed_hook_posted_without_a_signature_is_404_not_401():
    """404 for every refusal, so a probe cannot separate 'wrong token' from
    'right token, no signature'."""
    hook = store.create_hook("gh", "github", secret="s3cret")
    h, box = _mini(b'{"title":"x"}')

    h._hook(hook["token"])

    assert box["code"] == 404


def test_a_correctly_signed_post_is_accepted():
    hook = store.create_hook("gh", "github", secret="s3cret")
    raw = b'{"title":"x"}'
    h, box = _mini(raw, {"X-Hub-Signature-256": "sha256=" + _sign("s3cret", raw)})

    h._hook(hook["token"])

    assert box["code"] == 200


def test_an_oversized_body_is_refused_before_it_is_read():
    hook = store.create_hook("ci", "ci")
    h, box = _mini(b"{}", {"Content-Length": str(hooks.MAX_BODY + 1)})

    h._hook(hook["token"])

    assert box["code"] == 413
    assert store.get_hook(hook["token"])["hits"] == 0


def test_a_crash_answers_500_rather_than_a_misleading_404(monkeypatch):
    """Telling a sender 'wrong token' when the fault was ours sends whoever
    configured it to debug the wrong end."""
    hook = store.create_hook("ci", "ci")

    def boom(*a, **kw):
        raise RuntimeError("store is down")
    monkeypatch.setattr(hooks, "receive", boom)
    h, box = _mini(b"{}")

    h._hook(hook["token"])

    assert box["code"] == 500


# --- the dashboard panel API -------------------------------------------------

def test_minting_returns_the_token_once_and_the_url_to_paste():
    h, box = _dash()

    h._post_api("/local/hooks", {"action": "create", "label": "gh", "source": "github"})

    assert box["code"] == 200
    assert box["obj"]["hook"]["token"]
    assert box["obj"]["hook"]["url"].endswith("/hook/" + box["obj"]["hook"]["token"])


def test_an_unknown_source_is_rejected():
    h, box = _dash()

    h._post_api("/local/hooks", {"action": "create", "source": "carrier-pigeon"})

    assert box["code"] == 400


def test_the_list_never_carries_a_secret_back_to_the_panel():
    store.create_hook("signed", "github", secret="s3cret")
    h, box = _dash()

    h._get_api("/local/hooks", {})

    assert box["code"] == 200
    row = [x for x in box["obj"]["hooks"] if x["label"] == "signed"][0]
    assert row["signed"] is True and "secret" not in row
    assert "s3cret" not in json.dumps(box["obj"])


def test_the_feed_shows_events_newest_first():
    hook = store.create_hook("ci", "ci")
    for i in range(3):
        hooks.receive(hook["token"], json.dumps({"title": f"e{i}"}).encode(), {})
    h, box = _dash()

    h._get_api("/local/hooks", {})

    assert [e["title"] for e in box["obj"]["events"][:3]] == ["e2", "e1", "e0"]
    assert box["obj"]["events"][0]["label"] == "ci"


def test_revoking_a_hook_shuts_its_url_off():
    hook = store.create_hook("doomed", "ci")
    h, box = _dash()

    h._post_api("/local/hooks", {"action": "delete", "token": hook["token"]})

    assert box["obj"]["ok"] is True
    mh, mbox = _mini(b'{"title":"too late"}')
    mh._hook(hook["token"])
    assert mbox["code"] == 404


def test_an_unknown_action_is_rejected():
    h, box = _dash()

    h._post_api("/local/hooks", {"action": "detonate"})

    assert box["code"] == 400
