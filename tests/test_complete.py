"""What the composer completes from disk: paths and the names a project's code defines."""
import os
import subprocess

from bridge import complete
from bridge.dashboard import server as dash


def test_paths_list_one_folder_with_folders_marked(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "setup.py").write_text("")
    (tmp_path / ".secret").write_text("")
    (tmp_path / "Readme.md").write_text("")
    got = complete.paths(str(tmp_path), "s")
    assert [p["text"] for p in got] == ["src/", "setup.py"] and got[0]["dir"] is True
    assert [p["text"] for p in complete.paths(str(tmp_path), "./")] == ["./src/", "./Readme.md", "./setup.py"], "folders first; hidden ones left out"
    assert [p["text"] for p in complete.paths(str(tmp_path), "./.s")] == ["./.secret"], "unless you typed the dot"
    assert [p["text"] for p in complete.paths(str(tmp_path), "r")] == ["Readme.md"], "any case"
    assert complete.paths(str(tmp_path), "nope/") == [] and complete.paths(str(tmp_path), "") == []


def test_paths_from_home_and_from_the_root(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "Documents").mkdir()
    assert complete.paths("/nowhere", "~/Doc") == [{"text": "~/Documents/", "name": "Documents/", "dir": True}]
    assert any(p["text"] == "/tmp/" for p in complete.paths("/nowhere", "/tm"))


def test_names_come_from_the_code_git_tracks(tmp_path):
    r = str(tmp_path)
    subprocess.run(["git", "init", "-q", r], check=True)
    (tmp_path / "a.py").write_text("def helper_ended():\n    pass\nclass WorkPanel:\n    def run(self): pass\nMAX = 1\n")
    (tmp_path / "b.ts").write_text("export function useRefSession() {}\nexport const workGet = 1\ninterface Listing {}\nexport type Run = {}\n")
    (tmp_path / "notes.md").write_text("def not_code():\n")
    (tmp_path / "untracked.py").write_text("def hidden_one(): pass\n")
    subprocess.run(["git", "-C", r, "add", "a.py", "b.ts", "notes.md"], check=True)
    names = {s["name"]: s["file"] for s in complete.symbols(r)}
    assert {"helper_ended", "WorkPanel", "run", "useRefSession", "workGet", "Listing", "Run"} <= set(names)
    assert "not_code" not in names and "hidden_one" not in names and names["useRefSession"] == "b.ts"


def test_names_are_cached_until_the_index_changes(tmp_path):
    r = str(tmp_path)
    subprocess.run(["git", "init", "-q", r], check=True)
    (tmp_path / "a.py").write_text("def first_one(): pass\n")
    subprocess.run(["git", "-C", r, "add", "a.py"], check=True)
    assert [s["name"] for s in complete.symbols(r)] == ["first_one"]
    (tmp_path / "b.py").write_text("def second_one(): pass\n")
    assert [s["name"] for s in complete.symbols(r)] == ["first_one"], "same index, same answer"
    subprocess.run(["git", "-C", r, "add", "b.py"], check=True)
    os.utime(os.path.join(r, ".git", "index"), None)
    assert {s["name"] for s in complete.symbols(r)} == {"first_one", "second_one"}


def test_a_folder_that_isnt_one_answers_nothing():
    assert complete.symbols("/nonexistent") == [] and complete.symbols("") == []
