"""Images in the conversation (bridge/chat_images.py): the setting, saving, where they go,
what the file route will and won't serve, and what the agent is told."""
import base64
import json
import os
import subprocess
import time

import pytest

from bridge import chat_images, config, experimental, multi_api, runner, store, team

store.init()
CHAT = config.DASH_CHAT_ID
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(chat_images, "_path", lambda: str(tmp_path / "chat_images.json"))
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path))
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path / "up"))
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)


def _repo(tmp_path):
    r = tmp_path / "proj"
    r.mkdir()
    subprocess.run(["git", "init", "-q", str(r)], check=True)
    subprocess.run(["git", "-C", str(r), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(r), "config", "user.name", "t"], check=True)
    (r / "a").write_text("x\n")
    subprocess.run(["git", "-C", str(r), "add", "."], check=True)
    subprocess.run(["git", "-C", str(r), "commit", "-qm", "x"], check=True)
    return r


def test_attachment_is_the_default_and_the_switch_persists():
    assert chat_images.mode() == "attachment"
    assert multi_api.get("chat-images", {}, CHAT)[0]["mode"] == "attachment"
    assert multi_api.post("chat-images", {"mode": "inline"}, CHAT)[0]["mode"] == "inline"
    assert chat_images.mode() == "inline"
    assert multi_api.post("chat-images", {"mode": "nope"}, CHAT)[1] == 400


def test_upload_saves_a_timestamped_file_in_the_project_and_stays_out_of_git(tmp_path):
    r = _repo(tmp_path)
    s = store.create_session(CHAT, "/proj", cwd=str(r))
    out, code = multi_api.post("chat-images/upload", {"session_id": s["id"], "data": URL}, CHAT)
    assert code == 200, out
    assert out["path"].startswith(".mystical/images/") and out["path"].endswith(".png")
    assert out["markdown"] == f"![image]({out['path']})"
    assert (r / out["path"]).read_bytes() == PNG
    st = subprocess.run(["git", "-C", str(r), "status", "--short"], capture_output=True, text=True).stdout
    assert st == ""


def test_two_in_one_second_get_their_own_names(tmp_path):
    r = _repo(tmp_path)
    a = chat_images.save_data_url(URL, str(r))
    b = chat_images.save_data_url(URL, str(r))
    assert a != b


def test_a_new_chat_saves_by_its_project(tmp_path):
    r = _repo(tmp_path)
    out, code = multi_api.post("chat-images/upload", {"project": "/proj", "data": URL}, CHAT)
    assert code == 200 and (r / out["path"]).exists()
    assert multi_api.post("chat-images/upload", {"project": "/../..", "data": URL}, CHAT)[1] == 400


@pytest.mark.parametrize("bad", ["hello", "data:text/html;base64,PGI+", "data:image/svg+xml;base64,PHN2Zz4="])
def test_only_images_go_in(tmp_path, bad):
    with pytest.raises(ValueError):
        chat_images.save_data_url(bad, str(tmp_path))


def test_too_big_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "UPLOAD_MAX_MB", 0)
    with pytest.raises(ValueError, match="over"):
        chat_images.save_data_url(URL, str(tmp_path))


def test_a_worktree_saves_in_the_main_checkout(tmp_path):
    r = _repo(tmp_path)
    wt = tmp_path / "wt"
    subprocess.run(["git", "-C", str(r), "worktree", "add", "-q", "-b", "x", str(wt)], check=True)
    assert chat_images.root_of(str(wt)) == os.path.realpath(r)
    assert chat_images.root_of(str(r)) == os.path.realpath(r)


def test_the_file_route_serves_images_and_nothing_else(tmp_path):
    r = _repo(tmp_path)
    rel = chat_images.save_data_url(URL, str(r))
    s = store.create_session(CHAT, "/proj", cwd=str(r))
    got = multi_api.image_file({"path": [rel], "session": [s["id"]]}, CHAT)
    assert got == (PNG, "image/png")
    (r / "secret.env").write_text("KEY=1")
    (r / "x.svg").write_text("<svg onload='x'/>")
    outside = tmp_path.parent / f"outside-{time.time_ns()}.png"
    outside.write_bytes(PNG)
    os.symlink(outside, r / "link.png")
    for bad in ("secret.env", "x.svg", "../../etc/passwd", "/etc/passwd", str(outside), "link.png",
                "https://x/y.png", "~/x.png", "nope.png"):
        assert multi_api.image_file({"path": [bad], "session": [s["id"]]}, CHAT) is None, bad
    assert multi_api.image_file({"path": [rel], "session": ["not-mine"]}, CHAT) is None
    outside.unlink()


def test_someone_elses_session_doesnt_resolve(tmp_path):
    r = _repo(tmp_path)
    rel = chat_images.save_data_url(URL, str(r))
    s = store.create_session(999, "/proj", cwd=str(r))
    assert multi_api.image_file({"path": [rel], "session": [s["id"]]}, CHAT) is None


def test_the_agent_is_told_the_real_path_and_the_text_stays(tmp_path):
    r = _repo(tmp_path)
    rel = chat_images.save_data_url(URL, str(r))
    text = f"look at this ![image]({rel}) and ![x](https://e.com/a.png) and ![gone](nope.png)"
    n = chat_images.note(text, str(r))
    assert str(os.path.realpath(r / rel)) in n and "e.com" not in n and "nope" not in n
    assert chat_images.note("no images here", str(r)) == ""
    # From a helper's worktree it still points at the main checkout's file.
    wt = tmp_path / "wt"
    subprocess.run(["git", "-C", str(r), "worktree", "add", "-q", "-b", "y", str(wt)], check=True)
    assert str(os.path.realpath(r / rel)) in chat_images.note(text, str(wt))


def test_an_image_quoted_as_code_isnt_one():
    assert chat_images.embeds("see `![a](x.png)` and ```\n![b](y.png)\n``` and ![c](z.png)") == ["z.png"]


def test_telegram_photos_go_in_the_text_when_inline(tmp_path):
    r = _repo(tmp_path)
    up = tmp_path / "up"
    up.mkdir()
    (up / "p.jpg").write_bytes(PNG)
    (up / "d.pdf").write_bytes(b"%PDF")
    keep, prompt = chat_images.adopt_files([str(up / "p.jpg"), str(up / "d.pdf")], "see", str(r))
    assert keep == [str(up / "p.jpg"), str(up / "d.pdf")] and prompt == "see"     # attachment mode
    chat_images.set_mode("inline")
    keep, prompt = chat_images.adopt_files([str(up / "p.jpg"), str(up / "d.pdf")], "see", str(r))
    assert keep == [str(up / "d.pdf")] and prompt.startswith("![image](.mystical/images/") and prompt.endswith("see")
    assert not (up / "p.jpg").exists()


def test_storage_never_offers_images_for_deleting():
    from bridge import storage
    assert "images" in storage.KEEP


def test_a_team_share_carries_images_and_drops_the_address(tmp_path):
    import gzip
    r = _repo(tmp_path)
    rel = chat_images.save_data_url(URL, str(r))
    s = store.create_session(CHAT, "/proj", cwd=str(r))
    store.start_turn(s["id"], f"t{time.time_ns()}", f"before ![image]({rel}) after", [])
    store.finish_turn(store.latest_turn_id(s["id"]), "done", None, 1)
    try:
        packed = team.pack_session(s["id"])
    except team.TeamError as e:
        pytest.skip(str(e))
    doc = json.loads(gzip.decompress(packed["payload"]))
    assert ".mystical" not in doc["turns"][0]["prompt"] and "before" in doc["turns"][0]["prompt"]
    assert doc["turns"][0]["attachments"] and packed["pictures"]


def test_a_turn_starts_with_the_note_in_front_of_the_prompt(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(runner, "_run_streaming", lambda job, *a, **k: seen.update(prefix=job.prefix))
    monkeypatch.setattr(runner, "_register", lambda job: None)
    monkeypatch.setattr(runner.state, "acquire_run", lambda *a: True)
    monkeypatch.setattr(runner.state, "release_run", lambda *a: None)
    from bridge import learn, titler
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(learn, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_ensure_journal_thread", lambda: None)
    r = _repo(tmp_path)
    rel = chat_images.save_data_url(URL, str(r))
    s = store.create_session(CHAT, "/proj", cwd=str(r))
    runner.start_streaming_job(CHAT, f"![image]({rel})", [], project=str(r), session_id=s["id"])
    time.sleep(0.2)
    assert "open them before responding" in seen["prefix"]
    # The stored prompt stays what was typed.
    assert store.turns_of(s["id"])[-1]["prompt"] == f"![image]({rel})"


def test_off_with_the_experimental_switch(tmp_path):
    """Images in the chat are experimental: off, it's attachments, and nothing is reachable."""
    r = _repo(tmp_path)
    rel = chat_images.save_data_url(URL, str(r))
    chat_images.set_mode("inline")
    s = store.create_session(CHAT, "/proj", cwd=str(r))
    experimental.set_enabled(False)
    assert chat_images.mode() == "attachment"
    assert multi_api.get("chat-images", {}, CHAT)[0]["mode"] == "attachment"
    assert multi_api.post("chat-images", {"mode": "inline"}, CHAT)[1] == 409
    assert multi_api.post("chat-images/upload", {"session_id": s["id"], "data": URL}, CHAT)[1] == 409
    assert multi_api.image_file({"path": [rel], "session": [s["id"]]}, CHAT) is None
    assert chat_images.note(f"![image]({rel})", str(r)) == ""
    keep, prompt = chat_images.adopt_files(["/tmp/x.png"], "hi", str(r))
    assert keep == ["/tmp/x.png"] and prompt == "hi"
    experimental.set_enabled(True)
    assert chat_images.mode() == "inline"       # the choice waits for it
