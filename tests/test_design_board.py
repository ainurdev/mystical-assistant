"""Design boards: pages on disk, comments, the tools an agent calls."""
import json
import os
import subprocess
import time

import pytest

from bridge import aifeatures, chat_images, config, design_audit, design_board as db, experimental, gateway, gateway_tools as gt, multi_api, store

PAGE = "<!doctype html><html><head><title>t</title></head><body><h1>Hello</h1></body></html>"


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path))
    return str(root.resolve())


def test_a_board_keeps_pages_in_the_project(repo):
    meta = db.put(repo, repo, {"title": "Home page!", "pages": [{"name": "A · Calm", "html": PAGE, "direction": "calm"}, {"name": "B", "html": PAGE}]})
    assert meta["id"] == "home-page" and [p["name"] for p in meta["pages"]] == ["A · Calm", "B"]
    d = os.path.join(repo, ".mystical", "design", "home-page")
    assert os.path.isfile(os.path.join(d, "board.json")) and os.path.isfile(os.path.join(d, "a-calm.html"))
    assert open(os.path.join(repo, ".mystical", ".gitignore")).read().strip() == "*"


def test_updating_a_board_adds_and_keeps_pages(repo):
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "html": PAGE}]})
    meta = db.put(repo, repo, {"board": "home", "title": "", "pages": [{"name": "B", "html": PAGE}, {"name": "A", "html": PAGE + "x"}]})
    assert [p["name"] for p in meta["pages"]] == ["A", "B"] and meta["title"] == "Home"


@pytest.mark.parametrize("spec,word", [
    ({"title": "T"}, "pages"), ({"title": "T", "pages": [{"html": PAGE}]}, "name"), ({"title": "T", "pages": [{"name": "A"}]}, "html"),
    ({"title": "T", "pages": [{"name": "A", "file": "/etc/passwd"}]}, "isn't an HTML file"),
    ({"title": "T", "pages": [{"name": "A", "file": "nope.html"}]}, "isn't an HTML file"),
    ({"title": "T", "pages": [{"name": str(i), "html": PAGE} for i in range(db.MAX_PAGES + 1)]}, "holds"),
    ({"title": "T", "pages": [{"name": "A", "html": "x" * (db.MAX_PAGE_BYTES + 1)}]}, "MB"),
])
def test_refusals_say_what_to_change(repo, spec, word):
    with pytest.raises(db.Refused, match=word):
        db.put(repo, repo, spec)


def test_a_file_outside_the_project_isnt_served(repo, tmp_path, monkeypatch):
    other = tmp_path.parent / f"outside-{time.time_ns()}.html"
    other.write_text(PAGE)
    with pytest.raises(db.Refused):
        db.put(repo, repo, {"title": "T", "pages": [{"name": "A", "file": str(other)}]})
    os.remove(other)


def test_polling_sees_edits_to_the_file_and_keeps_versions(repo):
    f = os.path.join(repo, "page.html")
    open(f, "w").write(PAGE)
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "file": "page.html"}]})
    first, _ = db.poll(repo, {"board": "home"})
    assert first["html"] == PAGE and first["version"] == 1 and first["pages"][0]["file"] == "page.html"
    same, _ = db.poll(repo, {"board": "home", "have": first["hash"]})
    assert "html" not in same
    open(f, "w").write(PAGE.replace("Hello", "Bye"))
    next_, _ = db.poll(repo, {"board": "home", "have": first["hash"]})
    assert "Bye" in next_["html"] and next_["version"] == 2 and next_["versions"] == [1, 2]
    assert "Hello" in db.read_version(repo, "home", "A", 1)
    assert db.read_version(repo, "home", "A", 99) is None


def test_old_versions_are_let_go(repo, monkeypatch):
    monkeypatch.setattr(db, "KEEP", 3)
    f = os.path.join(repo, "page.html")
    open(f, "w").write(PAGE)
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "file": "page.html"}]})
    for i in range(6):
        open(f, "w").write(PAGE + str(i))
        db.poll(repo, {"board": "home"})
    assert db.versions(repo, "home", "A") == [5, 6, 7]


def test_a_gone_page_and_board_say_so(repo):
    f = os.path.join(repo, "page.html")
    open(f, "w").write(PAGE)
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "file": "page.html"}]})
    os.remove(f)
    assert db.poll(repo, {"board": "home"})[0]["missing"] is True
    assert db.poll(repo, {"board": "other"})[1] == 404
    assert db.poll(repo, {"board": "../../x"})[1] == 404


def test_local_images_are_inlined_and_only_images_from_the_project(repo, tmp_path):
    open(os.path.join(repo, "pic.png"), "wb").write(b"\x89PNG")
    open(os.path.join(repo, "secret.txt"), "w").write("x")
    html = '<img src="pic.png"><img src="secret.txt"><img src="/etc/passwd"><img src="https://x.io/a.png"><img src="data:image/png;base64,AA">'
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "html": "x"}]})
    out = db._inline_images(html, repo, repo)
    assert 'src="data:image/png;base64,iVBORw==' in out and 'src="secret.txt"' in out and 'src="/etc/passwd"' in out
    assert 'src="https://x.io/a.png"' in out


def test_comments_saved_edited_sent_and_removed(repo):
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "html": PAGE}]})
    c = {"id": "c1", "kind": "comment", "page": "A", "text": "too heavy", "x": 10.26, "y": 20, "selector": "h1", "about": "h1", "styles": {"fontSize": "48px"}}
    rows = db.edit_comments(repo, {"board": "home", "put": c})[0]["comments"]
    assert rows[0]["status"] == "open" and rows[0]["x"] == 10.3 and rows[0]["styles"] == {"fontSize": "48px"}
    rows = db.edit_comments(repo, {"board": "home", "put": {**c, "text": "lighter"}})[0]["comments"]
    assert len(rows) == 1 and rows[0]["text"] == "lighter"
    assert db.edit_comments(repo, {"board": "home", "sent": ["c1"]})[0]["comments"][0]["status"] == "sent"
    assert db.edit_comments(repo, {"board": "home", "drop": "c1"})[0]["comments"] == []


def test_a_drawing_may_have_no_words_and_a_tweak_keeps_its_values(repo):
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "html": PAGE}]})
    rows = db.edit_comments(repo, {"board": "home", "put": {"id": "d", "kind": "draw", "page": "A", "text": "", "points": [[1, 2], [3, 4], "bad"]}})[0]["comments"]
    assert rows[0]["points"] == [[1.0, 2.0], [3.0, 4.0]] and rows[0]["text"] == ""
    rows = db.edit_comments(repo, {"board": "home", "put": {"id": "t", "kind": "tweak", "page": "A", "changes": [{"prop": "color", "from": "red", "to": "blue"}]}})[0]["comments"]
    assert rows[1]["changes"] == [{"prop": "color", "from": "red", "to": "blue"}]
    assert db.edit_comments(repo, {"board": "nope", "put": {"id": "x"}})[1] == 404


def test_listing_and_deleting_only_the_boards_own_folder(repo):
    f = os.path.join(repo, "page.html")
    open(f, "w").write(PAGE)
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "file": "page.html"}]})
    db.edit_comments(repo, {"board": "home", "put": {"id": "c", "page": "A", "text": "x"}})
    got = db.listed(repo)[0]["boards"]
    assert got[0]["id"] == "home" and got[0]["open"] == 1
    assert db.delete(repo, "../..")[1] == 404 and db.delete(repo, "nope")[1] == 404
    assert db.delete(repo, "home")[1] == 200
    assert os.path.isfile(f) and db.listed(repo)[0]["boards"] == []


# ---- what's already decided, and references ---------------------------------------------

def test_context_says_what_to_reuse(repo):
    os.makedirs(os.path.join(repo, "src", "components"))
    open(os.path.join(repo, "DESIGN.md"), "w").write("Calm and bookish.")
    open(os.path.join(repo, "src", "a.css"), "w").write(":root { --ink: #111; --gap: 8px; }")
    open(os.path.join(repo, "src", "components", "Card.tsx"), "w").write("x")
    subprocess.run(["git", "-C", repo, "add", "-A"], check=True)
    said = design_audit.context(repo)
    assert "Calm and bookish." in said and "--ink: #111" in said and "Card" in said


def test_context_offers_a_design_file_when_there_is_none(repo):
    assert "No DESIGN.md" in design_audit.context(repo)


@pytest.mark.parametrize("url", ["http://localhost:8790/", "http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/", "file:///etc/passwd", "nope"])
def test_a_reference_is_a_public_page(repo, url):
    out, code = design_audit.reference(repo, {"url": url})
    assert code == 400 and "public" in out["error"]


def test_a_reference_can_be_a_picture_in_the_project(repo):
    open(os.path.join(repo, "like.png"), "wb").write(b"\x89PNG")
    out, code = design_audit.reference(repo, {"image": "like.png", "note": "this calm"})
    assert code == 200 and out["reference"]["path"] == "like.png" and design_audit.references(repo)[0]["note"] == "this calm"
    assert design_audit.reference(repo, {"image": "/etc/passwd"})[1] == 404


def test_the_critic_reads_only_and_keeps_its_answer(repo, monkeypatch):
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "html": PAGE}]})
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)
    monkeypatch.setattr(design_audit, "inspect", lambda root, a: ("facts", []))
    seen = {}

    def fake(chat_id, prompt, **kw):
        seen.update(kw, prompt=prompt)
        return '```json\n{"scores":{"design":4},"verdict":"tidy, no ideas","fixes":[{"where":"h1","fix":"bigger"}]}\n```', None, None, False
    monkeypatch.setattr(design_audit.runner, "run_blocking", fake)
    assert design_audit.critique(repo, {"board": "home", "page": "A"}, 1)["state"] == "running"
    for _ in range(100):
        got = design_audit.critique(repo, {"board": "home", "page": "A"}, 1)
        if got["state"] != "running":
            break
        time.sleep(0.02)
    assert got["state"] == "done" and got["scores"]["design"] == 4 and got["fixes"][0]["fix"] == "bigger"
    assert seen["permission_mode"] == "plan" and seen["skip_pack"] is True and "skeptical" in seen["prompt"]


def test_the_critic_is_off_with_its_switch(repo, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    assert design_audit.critique(repo, {"board": "home"}, 1)["state"] == "failed"


# ---- through the tools and routes --------------------------------------------------------

class Job:
    def __init__(self):
        self.id, self.events = f"j{time.time_ns()}", []

    def add(self, e):
        self.events.append(e)


@pytest.fixture
def session(repo, monkeypatch, tmp_path):
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    return store.create_session(config.DASH_CHAT_ID, "/p", cwd=repo)


def test_show_design_puts_the_button_on_the_turn(session, repo):
    job = Job()
    res = gt.call(session, job, "show_design", {"title": "Home", "pages": [{"name": "A", "html": PAGE}]})
    ev = job.events[0]
    assert ev["type"] == "design" and ev["board"] == "home" and ev["pages"] == ["A"] and ev["ref"] == "v1"
    assert "PREVIEW DESIGN" in res["content"][0]["text"] and "a.html" in res["content"][0]["text"]
    bad = gt.call(session, job, "show_design", {"title": "Home2"})
    assert bad["isError"] and len(job.events) == 1


def test_every_provider_has_the_design_tools(session):
    assert "show_design" in gateway.tool_names(session)
    assert {"design_context", "inspect_ui", "critique_design", "grab_style"} <= gt.HANDLED


def test_routes_are_behind_the_switch_and_the_owner(session, repo):
    db.put(repo, repo, {"title": "Home", "pages": [{"name": "A", "html": PAGE}]})
    chat, body = config.DASH_CHAT_ID, {"session_id": session["id"], "board": "home"}
    assert multi_api.post("chat/design", body, chat)[0]["title"] == "Home"
    assert multi_api.post("chat/design", body, 999999)[1] == 404
    assert multi_api.post("chat/design-boards", {"session_id": session["id"]}, chat)[0]["boards"][0]["id"] == "home"
    experimental.set_enabled(False)
    assert multi_api.post("chat/design", body, chat)[1] == 409
