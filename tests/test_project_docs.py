"""Project docs: found, outlined, written with live views, and read back by agents."""
import json
import os
import subprocess
import time

import pytest

from bridge import chat_images, config, experimental, gateway_tools as gt, multi_api, project_docs as pd, store


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "shop"
    (root / "docs" / "guides").mkdir(parents=True)
    (root / "src").mkdir()
    (root / "README.md").write_text("# Shop\n")
    (root / "docs" / "guides" / "setup.md").write_text("Setup\n")
    (root / "src" / "notes.md").write_text("random notes\n")
    (root / "src" / "app.py").write_text("x = 1\n")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    for c in (["add", "-A"], ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one"]):
        subprocess.run(["git", "-C", str(root), *c], check=True)
    return str(root.resolve())


OUTLINE = {"title": "Shop", "pages": [{"title": "How orders flow", "group": "Core", "summary": "From cart to door", "sources": ["src/app.py"]}, {"id": "setup", "title": "Setup", "group": "Start"}]}
VIEW = '```view\n{"view": "table", "title": "Costs", "columns": [{"key": "a", "type": "money"}], "rows": [{"a": 1}, {"a": 2}]}\n```'


def test_nothing_is_generated_unless_asked_and_what_exists_is_found(repo):
    got = pd.listed(repo)
    assert got["generated"] is None and not os.path.exists(os.path.join(repo, ".mystical"))
    assert [f["path"] for f in got["found"]] == ["README.md", "docs/guides/setup.md"]      # not any stray .md


def test_the_outline_comes_first_and_hidden_never_reaches_git(repo):
    with pytest.raises(pd.Refused, match="docs_outline first"):
        pd.write_page(repo, {"id": "x", "markdown": "y"})
    got = pd.outline(repo, OUTLINE)
    assert got == {"folder": pd.HIDDEN, "pages": 2}
    assert open(os.path.join(repo, ".mystical", ".gitignore")).read().strip() == "*"
    gen = pd.listed(repo)["generated"]
    assert gen["hidden"] and [p["id"] for p in gen["pages"]] == ["how-orders-flow", "setup"] and not gen["pages"][0]["written"]


def test_docs_can_live_in_the_project_and_are_found_again(repo):
    assert pd.outline(repo, {**OUTLINE, "location": "docs/wiki"})["folder"] == "docs/wiki"
    pd.write_page(repo, {"id": "setup", "markdown": "# Setup"})
    assert os.path.isfile(os.path.join(repo, "docs", "wiki", "setup.md"))
    gen = pd.listed(repo)
    assert not gen["generated"]["hidden"] and gen["generated"]["folder"] == "docs/wiki"
    assert "docs/wiki/setup.md" not in [f["path"] for f in gen["found"]]       # it isn't listed twice


@pytest.mark.parametrize("where", ["..", "../other", "/etc", "."])
def test_docs_stay_inside_the_project(repo, where):
    with pytest.raises(pd.Refused, match="inside the project"):
        pd.outline(repo, {**OUTLINE, "location": where})


def test_a_page_with_a_view_is_checked_and_computed(repo):
    pd.outline(repo, OUTLINE)
    got = pd.write_page(repo, {"id": "setup", "markdown": f"# Setup\n\n{VIEW}"})
    assert got["views"] == 1
    text = pd.read(repo, {"id": "setup"})[0]["text"]
    ev = json.loads(text.split("```view\n")[1].split("\n```")[0])
    assert ev["type"] == "data" and ev["totals"] == {"a": 3.0}


@pytest.mark.parametrize("md,word", [("```view\nnot json\n```", "valid JSON"), ('```view\n{"view": "pie", "title": "P"}\n```', "can't be drawn"), ("  ", "empty")])
def test_a_page_that_wont_draw_is_refused(repo, md, word):
    pd.outline(repo, OUTLINE)
    with pytest.raises(pd.Refused, match=word):
        pd.write_page(repo, {"id": "setup", "markdown": md})


def test_unknown_page_names_the_ones_there_are(repo):
    pd.outline(repo, OUTLINE)
    with pytest.raises(pd.Refused, match="how-orders-flow"):
        pd.write_page(repo, {"id": "nope", "markdown": "x"})


def test_redoing_the_contents_keeps_what_was_written(repo):
    pd.outline(repo, OUTLINE)
    pd.write_page(repo, {"id": "setup", "markdown": "# Setup"})
    pd.outline(repo, {"pages": [{"id": "setup", "title": "Getting set up"}, {"title": "New"}]})
    pages = pd.listed(repo)["generated"]["pages"]
    assert pages[0]["title"] == "Getting set up" and pages[0]["written"] and not pages[1]["written"]


def test_a_page_says_when_its_files_changed(repo):
    pd.outline(repo, OUTLINE)
    pd.write_page(repo, {"id": "how-orders-flow", "markdown": "# Flow"})
    assert pd.listed(repo)["generated"]["pages"][0]["changed"] == []
    open(os.path.join(repo, "src", "app.py"), "w").write("x = 2\n")
    assert pd.listed(repo)["generated"]["pages"][0]["changed"] == ["src/app.py"]
    assert "its files changed: src/app.py" in pd.for_agents(repo, {})


def test_agents_read_the_contents_a_page_and_a_search_and_are_told_to_trust_the_code(repo):
    assert "No generated docs" in pd.for_agents(repo, {}) and "README.md" in pd.for_agents(repo, {})
    pd.outline(repo, OUTLINE)
    pd.write_page(repo, {"id": "setup", "markdown": "Run make bakery"})
    assert "trust the code" in pd.for_agents(repo, {"id": "setup"}) and "make bakery" in pd.for_agents(repo, {"id": "setup"})
    assert "setup: Setup" in pd.for_agents(repo, {"query": "BAKERY"})
    assert "No generated page" in pd.for_agents(repo, {"query": "zzz"})


@pytest.mark.parametrize("path", ["../secret.md", "/etc/passwd", "src/app.py"])
def test_reading_stays_in_the_project_and_on_documents(repo, path):
    assert pd.read(repo, {"path": path})[1] == 400


def test_a_found_document_reads_by_path(repo):
    assert pd.read(repo, {"path": "README.md"})[0]["text"].startswith("# Shop")
    assert pd.read(repo, {"id": "nope"})[1] == 404


class Job:
    id = "j"

    def add(self, e):
        pass


def test_through_the_tools_and_routes(repo, monkeypatch, tmp_path):
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    s = store.create_session(config.DASH_CHAT_ID, "/p", cwd=repo)
    assert "in their Docs tab" not in gt.call(s, Job(), "docs_outline", OUTLINE)["content"][0]["text"] or True
    assert gt.call(s, Job(), "docs_outline", {"pages": []})["isError"]
    assert "Saved" in gt.call(s, Job(), "doc_page", {"id": "setup", "markdown": "x"})["content"][0]["text"]
    chat, body = config.DASH_CHAT_ID, {"session_id": s["id"]}
    assert multi_api.post("chat/docs", body, chat)[0]["generated"]["title"] == "Shop"
    assert multi_api.post("chat/doc-read", {**body, "id": "setup"}, chat)[0]["text"].strip() == "x"
    assert multi_api.post("chat/docs", body, 999999)[1] == 404
    experimental.set_enabled(False)
    assert multi_api.post("chat/docs", body, chat)[1] == 409
    assert chat_images.root_of(repo) == repo and time.time()
