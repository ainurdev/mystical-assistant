"""Keeping a view in the project, and sending a picture of one to Telegram."""
import base64
import json
import os

import pytest

from bridge import config, data_views, experimental, multi_api, saved_views as sv, store, telegram

VIEW = {"type": "data", "view": "table", "title": "Coverage / 2026!", "columns": [], "rows": [], "totals": {}}


def test_saved_listed_removed(tmp_path):
    root = str(tmp_path)
    out, code = sv.save(root, VIEW)
    assert code == 200 and "coverage-2026" in out["id"]
    assert os.path.isfile(tmp_path / ".mystical" / "views" / f"{out['id']}.json")
    assert (tmp_path / ".mystical" / ".gitignore").read_text().strip() == "*"     # never reaches git
    listed = sv.listed(root)[0]["views"]
    assert listed[0]["id"] == out["id"] and listed[0]["view"]["title"] == VIEW["title"]
    assert sv.delete(root, out["id"])[1] == 200 and sv.listed(root)[0]["views"] == []


@pytest.mark.parametrize("view", [None, "x", {"type": "figure"}, {"type": "data", "view": "pie"}])
def test_what_isnt_a_view_isnt_kept(tmp_path, view):
    assert sv.save(str(tmp_path), view)[1] == 400


def test_no_project_and_too_big(tmp_path):
    assert sv.save(None, VIEW)[1] == 400
    assert sv.save(str(tmp_path), {**VIEW, "rows": ["x" * (data_views.MAX_BYTES * 2)]})[1] == 400
    assert sv.listed(None)[0] == {"views": []}


@pytest.mark.parametrize("vid", ["../../etc/passwd", "a/b", ".hidden", "", None, "gone"])
def test_removing_stays_in_the_folder(tmp_path, vid):
    assert sv.delete(str(tmp_path), vid)[1] == 404


def test_a_stray_file_is_left_out(tmp_path):
    d = tmp_path / ".mystical" / "views"
    d.mkdir(parents=True)
    (d / "note.json").write_text("not json")
    (d / "other.json").write_text(json.dumps({"view": "pie"}))
    assert sv.listed(str(tmp_path))[0]["views"] == []


def test_a_project_can_fill_up(tmp_path, monkeypatch):
    monkeypatch.setattr(sv, "MAX_SAVED", 1)
    assert sv.save(str(tmp_path), VIEW)[1] == 200
    assert sv.save(str(tmp_path), VIEW)[1] == 400


def test_sending_goes_to_you_and_cleans_up(monkeypatch):
    sent = []

    def fake(chat, path, name, caption=""):
        sent.append((chat, open(path, "rb").read(), name, caption, path))
        return True
    monkeypatch.setattr(telegram, "send_document", fake)
    data = base64.b64encode(b"png").decode()
    assert sv.send({"name": 'a"/b.png', "data": data, "caption": "T"}, 42)[1] == 200
    chat, raw, name, caption, path = sent[0]
    assert (chat, raw, caption) == (42, b"png", "T") and "/" not in name and '"' not in name and not os.path.exists(path)
    monkeypatch.setattr(config, "DASH_CHAT_ID", 7)
    sv.send({"name": "a", "data": data}, -100)                 # a group's not where it goes
    assert sent[1][0] == 7


def test_sending_refuses_and_reports(monkeypatch):
    monkeypatch.setattr(telegram, "send_document", lambda *a, **k: False)
    assert sv.send({"name": "a", "data": "!!!"}, 42)[1] == 400
    assert sv.send({"name": "a", "data": ""}, 42)[1] == 400
    assert sv.send({"name": "a", "data": base64.b64encode(b"x").decode()}, 42)[1] == 502


def test_the_routes_are_behind_the_switch_and_the_owner(tmp_path, monkeypatch):
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    store.init()
    s = store.create_session(config.DASH_CHAT_ID, "/p", cwd=str(tmp_path))
    chat = config.DASH_CHAT_ID
    experimental.set_enabled(False)
    assert multi_api.post("saved-views/send", {"name": "a", "data": "eA=="}, chat)[1] == 409
    assert multi_api.get("saved-views", {"session": [s["id"]]}, chat)[1] == 409
    experimental.set_enabled(True)
    out, code = multi_api.post("chat/view-save", {"session_id": s["id"], "view": VIEW}, chat)
    assert code == 200
    assert multi_api.get("saved-views", {"session": [s["id"]]}, chat)[0]["views"][0]["id"] == out["id"]
    assert multi_api.post("chat/view-save", {"session_id": s["id"], "view": VIEW}, 999999)[1] == 404
    assert multi_api.post("saved-views/delete", {"session_id": s["id"], "id": out["id"]}, chat)[1] == 200
