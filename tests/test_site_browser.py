"""The Mystical browser (bridge/site_browser.py): which Chromium it starts, who may talk to its
extension server, and where Send all puts the comments."""
import base64
import http.client
import json
import os
import stat

import pytest

from bridge import config, queue_manager, site_browser as sb, store

store.init()
CHAT = config.DASH_CHAT_ID
PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(sb, "home", lambda: str(tmp_path / "browser"))
    monkeypatch.setattr(sb, "_launch", lambda args: launched.append(args))
    monkeypatch.setattr(sb, "_no_screen", lambda: None)
    launched.clear()
    sent.clear()
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: sent.append((sid, kw)) or "item")
    yield
    sb.stop_serving()
    sb._pins.clear()


launched: list = []
sent: list = []


def _chat(title="NR staging polish", project="/nr/kantoor"):
    s = store.create_session(CHAT, project, cwd=os.path.join(config.BASE_PATH, "nr", "kantoor"))
    store.rename(s["id"], title)
    return store.get_session(s["id"])


def _ask(method, path, body=None, token=None, host=None):
    port = sb.serve()
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"X-Mystical-Token": token if token is not None else sb._server.token,
         "Host": host or f"127.0.0.1:{port}", "Content-Type": "application/json"}
    c.request(method, path, json.dumps(body).encode() if body is not None else None, h)
    r = c.getresponse()
    return r.status, json.loads(r.read() or b"{}")


# ------- which Chromium -------------------------------------------------------------------

def _fake_bin(p):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("#!/bin/sh\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


def test_the_newest_playwright_chromium_is_picked(tmp_path, monkeypatch):
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "pw"))
    _fake_bin(tmp_path / "pw/chromium-1248/chrome-linux/chrome")
    new = _fake_bin(tmp_path / "pw/chromium-1254/chrome-linux/chrome")
    _fake_bin(tmp_path / "pw/chromium_headless_shell-9999/chrome-linux/headless_shell")
    assert sb.chromium() == new


def test_no_chromium_is_none(tmp_path, monkeypatch):
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "empty"))
    monkeypatch.setattr(sb.os.path, "expanduser", lambda p: str(tmp_path / "nohome"))
    assert sb.chromium() is None


# ------- opening -------------------------------------------------------------------------

def test_open_site_remembers_the_chat_and_installs_the_extension():
    s = _chat()
    got = sb.open_site(s["id"], "staging.example.nl/planning")
    assert got["url"] == "https://staging.example.nl/planning"
    assert launched == [["https://staging.example.nl/planning"]]
    assert sb.opener("https://staging.example.nl/other")["id"] == s["id"]
    cfg = json.load(open(os.path.join(sb.home(), "ext", "config.json")))
    assert cfg["port"] == sb._server.server_address[1] and len(cfg["token"]) >= 32
    assert os.path.isfile(os.path.join(sb.home(), "ext", "manifest.json"))


def test_a_restart_keeps_the_port_and_token_an_open_browser_has():
    sb.serve()
    before = (sb._server.server_address[1], sb._server.token)
    sb.stop_serving()
    sb.serve_if_used()
    assert (sb._server.server_address[1], sb._server.token) == before


def test_no_server_at_boot_when_the_browser_was_never_used():
    sb.serve_if_used()
    assert sb._server is None


def test_only_web_addresses_open():
    with pytest.raises(sb.Refused):
        sb.open_site(_chat()["id"], "file:///etc/passwd")


# ------- who may ask ---------------------------------------------------------------------

def test_a_wrong_token_or_host_is_refused():
    assert _ask("GET", "/chats?url=x", token="nope")[0] == 403
    assert _ask("GET", "/chats?url=x", host="evil.example:80")[0] == 403
    assert _ask("GET", "/chats?url=x")[0] == 200


def test_chats_names_the_opener_first_and_the_others_apart():
    a, b = _chat("Opener"), _chat("Other")
    sb.open_site(a["id"], "https://site.test/x")
    code, got = _ask("GET", "/chats?url=https%3A%2F%2Fsite.test%2Fy")
    assert code == 200 and got["opener"]["id"] == a["id"]
    ids = [c["id"] for c in got["chats"]]
    assert b["id"] in ids and a["id"] not in ids


def test_the_tray_wears_the_theme_the_dashboard_last_saved(tmp_path, monkeypatch):
    from bridge import design_board
    monkeypatch.setattr(design_board, "_theme_path", lambda: str(tmp_path / "theme.json"))
    assert _ask("GET", "/theme") == (200, {})                      # none saved: the tray keeps its own look
    design_board.save_theme({"theme": "osgiliath", "fam": "middle-earth", "tokens": {"--acc": "#6775de"}})
    code, got = _ask("GET", "/theme")
    assert code == 200 and got["tokens"] == {"--acc": "#6775de"} and got["fam"] == "middle-earth"
    assert _ask("GET", "/theme", token="nope")[0] == 403


# ------- Send all ------------------------------------------------------------------------

def test_send_all_goes_to_the_opener_as_one_turn_with_crops():
    s = _chat()
    sb.open_site(s["id"], "https://site.test/planning")
    sb.pinned({"url": "https://site.test/planning", "count": 2})
    assert sb.state(s["id"], "https://site.test/")["pinned"] == 2
    code, got = _ask("POST", "/send", {"url": "https://site.test/planning", "viewport": "1440×900", "comments": [
        {"text": "nav should look active", "where": 'a.nav · "Planning"', "crop": PNG},
        {"text": "rows too tight", "where": "tr"}]})
    assert code == 200 and got["chat"]["id"] == s["id"]
    (sid, kw), = sent
    assert sid == s["id"] and kw["sent_by"] == "browser"
    assert "2 comments from the Mystical browser on https://site.test/planning (window 1440×900)" in kw["prompt"]
    assert "1. nav should look active" in kw["prompt"] and "picture: comment-1.png" in kw["prompt"]
    assert "picture: comment-2.png" not in kw["prompt"]
    assert [os.path.basename(p).endswith("comment-1.png") for p in kw["images"]] == [True]
    assert sb.state(s["id"], "https://site.test/")["pinned"] == 0


def test_send_all_to_another_chat_and_it_becomes_the_default():
    a, b = _chat("Opener"), _chat("Other")
    sb.open_site(a["id"], "https://site.test/")
    got = sb.send({"url": "https://site.test/", "target": "chat", "chat": b["id"], "comments": [{"text": "hi"}]})
    assert got["chat"]["id"] == b["id"] and sent[0][0] == b["id"]
    assert sb.opener("https://site.test/")["id"] == b["id"]
    assert sb.state(a["id"], "https://site.test/")["to"] == "Other"      # a's card says where they go now
    assert sb.state(b["id"], "https://site.test/")["to"] is None


def test_send_all_to_a_new_chat_on_the_openers_project():
    a = _chat()
    sb.open_site(a["id"], "https://site.test/")
    got = sb.send({"url": "https://site.test/", "target": "new", "comments": [{"text": "hi"}]})
    new = store.get_session(got["chat"]["id"])
    assert new["id"] != a["id"] and new["project"] == a["project"] and new["cwd"] == a["cwd"]
    assert new["title"] == "Comments on site.test" and sent[0][0] == new["id"]


def test_send_refuses_empty_unknown_and_orphaned():
    with pytest.raises(sb.Refused):
        sb.send({"url": "https://nobody.test/", "comments": [{"text": "x"}]})     # no opener
    a = _chat()
    sb.open_site(a["id"], "https://site.test/")
    with pytest.raises(sb.Refused):
        sb.send({"url": "https://site.test/", "comments": [{"text": "   "}]})
    with pytest.raises(sb.Refused):
        sb.send({"url": "https://site.test/", "target": "chat", "chat": "nope", "comments": [{"text": "x"}]})
    assert sent == []


def test_a_crop_that_isnt_a_png_data_url_is_dropped():
    a = _chat()
    sb.open_site(a["id"], "https://site.test/")
    sb.send({"url": "https://site.test/", "comments": [{"text": "x", "crop": "file:///etc/passwd"}]})
    assert sent[0][1]["images"] == [] and "picture:" not in sent[0][1]["prompt"]


# ------- the agent's tool and the card's route ------------------------------------------------

def test_open_site_tool_puts_the_card_in_the_turn():
    from bridge import gateway_tools as gt
    s = _chat()
    events = []
    job = type("J", (), {"add": lambda self, e: events.append(e)})()
    res = gt.call(s, job, "open_site", {"url": "site.test/a"})
    assert not res.get("isError") and events == [{"type": "browser", "url": "https://site.test/a", "profile": events[0]["profile"]}]
    assert gt.call(s, job, "open_site", {"url": "ftp://x"}).get("isError")


def test_the_card_route_opens_reports_and_refuses(monkeypatch):
    from bridge import experimental, multi_api
    monkeypatch.setattr(experimental, "enabled", lambda: True)   # the design tools' switch
    s = _chat()
    got, code = multi_api.post("chat/browser", {"session_id": s["id"], "op": "open", "url": "site.test"}, CHAT)
    assert code == 200 and got["url"] == "https://site.test" and sb.opener("https://site.test")["id"] == s["id"]
    got, code = multi_api.post("chat/browser", {"session_id": s["id"], "op": "state", "url": "https://site.test"}, CHAT)
    assert code == 200 and got == {"running": False, "pinned": 0, "to": None}
    assert multi_api.post("chat/browser", {"session_id": s["id"], "op": "open", "url": ""}, CHAT)[1] == 400


def test_a_helper_inside_a_chat_opens_the_site_for_that_chat():
    from bridge import gateway_tools as gt
    parent = _chat()
    child = store.create_session(CHAT, parent["project"])
    child = {**child, "parent_session": parent["id"]}
    gt.call(child, None, "open_site", {"url": "https://site.test/"})
    assert sb.opener("https://site.test/")["id"] == parent["id"]


def test_the_turn_goes_under_the_chat_it_belongs_to(monkeypatch):
    other_user = store.create_session(777, "/nr/kantoor")
    sb.open_site(other_user["id"], "https://site.test/")
    sb.send({"url": "https://site.test/", "comments": [{"text": "x"}]})
    assert sent[0][1]["chat_id"] == 777


def test_nonsense_from_the_extension_is_a_400_not_a_dropped_connection():
    a = _chat()
    sb.open_site(a["id"], "https://site.test/")
    assert _ask("POST", "/send", {"url": "https://site.test/", "comments": ["just a string"]})[0] == 400
    assert _ask("POST", "/pins", {"url": "https://site.test/", "count": "lots"})[0] == 400
    assert sent == []
