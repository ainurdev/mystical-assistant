"""telegram: stdlib HTTP client behaviours the `requests` version gave us for
free. Run: python tests/test_telegram.py"""
import io
import json
import os
import urllib.error

import pytest

from bridge import telegram


class _Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _fake_urlopen(captured, body=b'{"ok": true, "result": "yes"}'):
    def opener(req, timeout=None):
        captured["req"] = req
        return _Resp(body)
    return opener


def test_none_params_are_dropped(monkeypatch):
    """requests omitted None values; urlencode would post the string 'None'."""
    cap = {}
    monkeypatch.setattr(telegram, "urlopen", _fake_urlopen(cap))
    telegram.edit(1, 2, "hi", reply_markup=None)
    assert b"reply_markup" not in cap["req"].data
    assert b"text=hi" in cap["req"].data


def test_error_body_is_parsed_not_raised(monkeypatch):
    """Telegram reports failures in a 4xx JSON body — tg() must read it, not blow up."""
    err = urllib.error.HTTPError(
        "u", 400, "Bad Request", {},
        io.BytesIO(json.dumps({"ok": False, "description": "nope"}).encode()))

    def boom(req, timeout=None):
        raise err
    monkeypatch.setattr(telegram, "urlopen", boom)
    assert telegram.tg("sendMessage", chat_id=1) is None


@pytest.mark.parametrize("exc", [
    TimeoutError(),                                    # raised bare while reading
    urllib.error.URLError(TimeoutError()),             # wrapped while connecting
])
def test_long_poll_timeout_is_silent(monkeypatch, exc):
    """An idle long-poll is normal: return [] fast, don't log-and-sleep."""
    def boom(req, timeout=None):
        raise exc
    monkeypatch.setattr(telegram, "urlopen", boom)
    monkeypatch.setattr(telegram.time, "sleep", lambda s: pytest.fail("slept on a normal timeout"))
    assert telegram.get_updates(0) == []


def test_real_network_error_backs_off(monkeypatch):
    def boom(req, timeout=None):
        raise urllib.error.URLError("dns is down")
    slept = []
    monkeypatch.setattr(telegram, "urlopen", boom)
    monkeypatch.setattr(telegram.time, "sleep", slept.append)
    assert telegram.get_updates(0) == []
    assert slept == [3]


def test_markdown_becomes_telegram_html():
    """Model output is markdown; without conversion it arrived as punctuation."""
    html = telegram._md_to_html(                              # noqa: SLF001
        "## Done\n**fixed** the `a < b` guard\n- see [it](http://x.io/a?b=1&c=2)")
    assert "<b>Done</b>" in html
    assert "<b>fixed</b>" in html
    assert "<code>a &lt; b</code>" in html                    # escaped inside code
    assert '<a href="http://x.io/a?b=1&amp;c=2">it</a>' in html
    assert "• see" in html


def test_code_fences_are_left_alone():
    """Markup inside a fence is content, not markup — and snake_case is not italic."""
    html = telegram._md_to_html(                              # noqa: SLF001
        "```py\nx = a_b_c  # **not bold** <tag>\n```")
    assert '<pre><code class="language-py">' in html
    assert "x = a_b_c  # **not bold** &lt;tag&gt;" in html
    assert "<b>" not in html and "<i>" not in html


def test_long_message_splits_on_lines_and_reopens_the_fence():
    """The old blind slice cut code blocks in half mid-token."""
    body = "\n".join(f"line {i} " + "x" * 60 for i in range(40))
    parts = telegram._chunks(f"intro\n```py\n{body}\n```", 500)   # noqa: SLF001
    assert len(parts) > 1
    for p in parts:
        assert len(p) <= 500 + 8                # +the reopened/closing fence
        assert p.count("```") % 2 == 0          # every chunk is self-contained
        assert not p.startswith("x")            # never split mid-line
    assert "".join(p for p in parts).count("line 39") == 1


def test_send_falls_back_to_plain_text_when_telegram_rejects_html():
    """A converter bug must cost the formatting, never the message."""
    sent = []

    def fake_tg(method, **params):
        sent.append(params)
        return None if params.get("parse_mode") else {"ok": True}
    telegram.tg, real = fake_tg, telegram.tg
    try:
        telegram.send(1, "**hi**")
    finally:
        telegram.tg = real
    assert [s.get("parse_mode") for s in sent] == ["HTML", None]
    assert sent[-1]["text"] == "**hi**"


def test_panel_kb_deep_links_to_the_session(monkeypatch):
    monkeypatch.setattr(telegram.state, "miniapp_url", "https://x.example")
    kb = telegram.panel_kb(42, "sess1", "/org/repo", "open")
    btn = kb["inline_keyboard"][0][0]
    assert btn["text"] == "open"
    assert btn["web_app"]["url"] == "https://x.example?s=sess1&p=%2Forg%2Frepo"
    assert telegram.panel_kb(42)["inline_keyboard"][0][0]["web_app"]["url"] \
        == "https://x.example"       # no session -> plain panel, no stray "?"


def test_panel_kb_is_none_where_telegram_would_reject_it(monkeypatch):
    """A rejected markup drops the whole message — so no button in groups, and
    none before the tunnel is up."""
    monkeypatch.setattr(telegram.state, "miniapp_url", "https://x.example")
    assert telegram.panel_kb(-100123, "sess1") is None
    monkeypatch.setattr(telegram.state, "miniapp_url", None)
    assert telegram.panel_kb(42, "sess1") is None


def test_button_rides_the_last_chunk():
    """Split a long answer and the way out has to be under the end of it."""
    sent = []
    telegram.tg, real = (lambda method, **p: sent.append(p) or {"ok": True}), telegram.tg
    try:
        telegram.send(1, "\n".join(f"line {i}" for i in range(2000)), {"inline_keyboard": []})
    finally:
        telegram.tg = real
    assert len(sent) > 1
    assert "reply_markup" not in sent[0] and "reply_markup" in sent[-1]


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
