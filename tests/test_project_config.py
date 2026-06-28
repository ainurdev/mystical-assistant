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
