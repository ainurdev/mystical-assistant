"""project_config: package.json script discovery + per-project run-command store."""

import json

from bridge import project_config


def test_package_scripts_reads_scripts(tmp_path):
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"dev": "vite", "build": "vite build"}}))
    assert project_config.package_scripts(str(tmp_path)) == {
        "dev": "vite", "build": "vite build"}


def test_package_scripts_missing_or_invalid(tmp_path):
    assert project_config.package_scripts(str(tmp_path)) == {}
    (tmp_path / "package.json").write_text("not json")
    assert project_config.package_scripts(str(tmp_path)) == {}
    (tmp_path / "package.json").write_text(json.dumps({"name": "x"}))  # no scripts
    assert project_config.package_scripts(str(tmp_path)) == {}


def test_run_cmd_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    assert project_config.run_cmd("/repo") is None
    project_config.set_run_cmd("/repo", "npm run dev")
    assert project_config.run_cmd("/repo") == "npm run dev"
    # blank clears the entry
    assert project_config.set_run_cmd("/repo", "") is None
    assert project_config.run_cmd("/repo") is None


def test_run_cmd_per_branch(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    # A directory-only command acts as the fallback for any branch.
    project_config.set_run_cmd("/repo", "npm run dev")
    assert project_config.run_cmd("/repo", branch="feat/x") == "npm run dev"
    # A branch-specific command overrides the fallback for that branch only.
    project_config.set_run_cmd("/repo", "npm run dev -- --port 4500", branch="feat/x")
    assert project_config.run_cmd("/repo", branch="feat/x") == "npm run dev -- --port 4500"
    assert project_config.run_cmd("/repo", branch="other") == "npm run dev"
    assert project_config.run_cmd("/repo") == "npm run dev"
    # prod URL scopes per branch the same way.
    project_config.set_prod_url("/repo", "https://x.example", branch="feat/x")
    assert project_config.prod_url("/repo", branch="feat/x") == "https://x.example"
    assert project_config.prod_url("/repo", branch="other") is None


def test_hidden_roundtrip_is_project_wide(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    assert project_config.hidden_projects() == []
    project_config.set_hidden("/repo", True)
    project_config.set_hidden("/other", True)
    assert project_config.hidden_projects() == ["/other", "/repo"]
    # a branch-scoped run_cmd never carries the flag
    project_config.set_run_cmd("/third", "npm run dev", branch="feat/x")
    assert project_config.hidden_projects() == ["/other", "/repo"]
    project_config.set_hidden("/repo", False)
    assert project_config.hidden_projects() == ["/other"]


def test_design_project_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    assert project_config.design_project("/repo") is None
    project_config.set_design_project("/repo", "24409d88-c74d-4d26-becb-69672612173f")
    assert project_config.design_project("/repo") == "24409d88-c74d-4d26-becb-69672612173f"
    # blank unlinks
    assert project_config.set_design_project("/repo", "") is None
    assert project_config.design_project("/repo") is None


def test_design_project_falls_back_to_the_directory_link(tmp_path, monkeypatch):
    """A redesign branch can point at its own design project; every other branch
    inherits the repo's."""
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    project_config.set_design_project("/repo", "aaaa-1")
    assert project_config.design_project("/repo", branch="feat/x") == "aaaa-1"
    project_config.set_design_project("/repo", "bbbb-2", branch="feat/x")
    assert project_config.design_project("/repo", branch="feat/x") == "bbbb-2"
    assert project_config.design_project("/repo", branch="other") == "aaaa-1"
    assert project_config.design_project("/repo") == "aaaa-1"
