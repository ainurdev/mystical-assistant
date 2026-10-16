"""bridge/integrations.py — which bundled plugins are installed, first-boot
adoption, and the door every plugin route passes on both servers.
Run: python -m pytest tests/test_integrations.py -v"""

import json
import os
import stat

import pytest

from bridge import integrations, project_config, rivendell, rivendell_instances, trackers

IDS = ["rivendell", "trackers", "design"]


@pytest.fixture
def fresh(monkeypatch, tmp_path):
    """A first boot with no plugins.json and nothing to adopt: a stranger's install."""
    path = tmp_path / "plugins.json"
    monkeypatch.setattr(integrations, "_path", lambda: str(path))
    monkeypatch.setattr(integrations, "_cache", None)
    monkeypatch.setattr(rivendell_instances, "raw_instances", lambda: [])
    monkeypatch.setattr(trackers, "connections", lambda: [])
    monkeypatch.setattr(project_config, "design_link_count", lambda: 0)
    monkeypatch.setattr(rivendell, "reconfigure", lambda: None)
    monkeypatch.setattr(rivendell, "running", lambda: [])
    return path


def test_the_registry_holds_the_three_bundled_plugins():
    assert [p["id"] for p in integrations.PLUGINS] == IDS
    for p in integrations.PLUGINS:
        assert {"id", "label", "blurb", "needs", "env_keys", "origins", "routes"} <= set(p)
    assert integrations.PLUGINS[0]["env_keys"] == ("FFMPEG_BIN", "WHISPER_BIN", "WHISPER_MODEL")
    assert integrations.PLUGINS[0]["origins"] == ("rivendell",)


def test_a_first_boot_with_nothing_to_adopt_installs_nothing(fresh):
    assert integrations.flags() == {"rivendell": False, "trackers": False, "design": False}
    assert json.loads(fresh.read_text()) == {"rivendell": False, "trackers": False, "design": False}
    assert stat.S_IMODE(os.stat(fresh).st_mode) == 0o600


ADOPT = {
    "rivendell": (rivendell_instances, "raw_instances", lambda: [{"id": "production"}]),
    "trackers": (trackers, "connections", lambda: [{"id": "c1"}]),
    "design": (project_config, "design_link_count", lambda: 1),
}


@pytest.mark.parametrize("pid", IDS)
def test_a_first_boot_adopts_what_the_machine_already_uses(fresh, monkeypatch, pid):
    mod, name, fake = ADOPT[pid]
    monkeypatch.setattr(mod, name, fake)
    assert integrations.flags() == {p: p == pid for p in IDS}


def test_adoption_runs_once_so_a_removal_survives_a_restart(fresh, monkeypatch):
    monkeypatch.setattr(rivendell_instances, "raw_instances", lambda: [{"id": "production"}])
    assert integrations.installed("rivendell")
    integrations.set_installed("rivendell", False)
    monkeypatch.setattr(integrations, "_cache", None)        # the next boot re-reads the file
    assert not integrations.installed("rivendell")


def test_a_corrupt_file_adopts_again(fresh, monkeypatch):
    fresh.write_text("{not json")
    monkeypatch.setattr(trackers, "connections", lambda: [{"id": "c1"}])
    assert integrations.installed("trackers")


def test_install_and_remove_persist(fresh):
    integrations.set_installed("design", True)
    assert json.loads(fresh.read_text())["design"] is True
    integrations.set_installed("design", False)
    assert integrations.installed("design") is False


def test_an_unknown_plugin_is_refused_and_reads_as_off(fresh):
    with pytest.raises(ValueError):
        integrations.set_installed("teleport", True)
    assert integrations.installed("teleport") is False


def test_rivendell_install_and_remove_reconcile_its_worker(fresh, monkeypatch):
    calls = []
    monkeypatch.setattr(rivendell, "reconfigure", lambda: calls.append(1))
    integrations.set_installed("rivendell", True)
    integrations.set_installed("rivendell", False)
    assert len(calls) == 2


def test_rivendell_reconciles_with_the_new_answer_in_place_and_the_lock_free(fresh, monkeypatch):
    """reconfigure() asks installed(), which takes the lock: called inside it, an install hangs."""
    seen = []

    def reconfigure():
        seen.append((integrations._lock.locked(), integrations._cache["rivendell"]))

    monkeypatch.setattr(rivendell, "reconfigure", reconfigure)
    integrations.set_installed("rivendell", True)
    integrations.set_installed("rivendell", False)
    assert seen == [(False, True), (False, False)]


def test_removing_rivendell_mid_run_is_refused(fresh, monkeypatch):
    integrations.set_installed("rivendell", True)
    monkeypatch.setattr(rivendell, "running", lambda: [{"request_id": "r1"}])
    with pytest.raises(integrations.IntegrationError, match="in flight"):
        integrations.set_installed("rivendell", False)
    assert integrations.installed("rivendell")


def test_plugin_origins_follow_the_install(fresh):
    assert not integrations.is_plugin_origin("rivendell:production")
    integrations.set_installed("rivendell", True)
    assert integrations.is_plugin_origin("rivendell:production")
    assert integrations.is_plugin_origin("rivendell")
    assert not integrations.is_plugin_origin("dashboard")
    assert not integrations.is_plugin_origin(None)


def test_every_plugin_route_has_an_owner():
    owner = integrations.route_owner
    assert owner("/local/rivendell") == owner("/local/rivendell/queue") == "rivendell"
    assert owner("/local/trackers") == owner("/local/tracker/tasks") == "trackers"
    assert owner("/api/tracker/update") == "trackers"
    assert owner("/local/design/prompt") == "design"
    assert owner("/local/rivendellx") is None
    assert owner("/local/sessions") is None


def test_state_summarises_only_what_is_installed(fresh, monkeypatch):
    monkeypatch.setattr(trackers, "connections", lambda: [{"id": "c1"}])
    integrations.set_installed("trackers", True)
    rows = {r["id"]: r for r in integrations.state()}
    assert set(rows["trackers"]) == {"id", "label", "blurb", "needs", "installed", "summary"}
    assert (rows["trackers"]["installed"], rows["trackers"]["summary"]) == (True, "1 connection")
    assert (rows["design"]["installed"], rows["design"]["summary"]) == (False, "")


def test_summaries_count_what_each_plugin_holds(fresh, monkeypatch):
    two = [{"enable": True}, {"enable": False}]
    monkeypatch.setattr(rivendell_instances, "instances", lambda: two)
    monkeypatch.setattr(project_config, "design_link_count", lambda: 3)
    for pid in IDS:
        integrations.set_installed(pid, True)
    assert {r["id"]: r["summary"] for r in integrations.state()} == {
        "rivendell": "2 instances · 1 on", "trackers": "0 connections", "design": "3 repos linked"}


def test_design_link_count_counts_linked_entries(monkeypatch, tmp_path):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    project_config.set_design_project("/app", "aaaa-1")
    project_config.set_design_project("/web", "bbbb-2", "main")
    project_config.set_run_cmd("/api", "npm run dev")
    assert project_config.design_link_count() == 2
