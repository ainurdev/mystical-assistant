"""bridge.aifeatures — the switch registry behind the dashboard's AI tab. What
matters here is the precedence (persisted > env > off) and that OFF is what an
untouched install gets, since every feature listed spends model calls.
Run: python -m pytest tests/test_aifeatures.py -v"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, config  # noqa: E402

KEYS = [f["key"] for f in aifeatures.FEATURES]


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    """Each test gets its own settings file; the module-level cache is dropped so
    nothing leaks between tests (or into the developer's real state dir)."""
    monkeypatch.setattr(config, "BRIDGE_DB", str(tmp_path / "bridge.db"))
    monkeypatch.setattr(aifeatures, "_cache", None)
    yield
    monkeypatch.setattr(aifeatures, "_cache", None)


def test_everything_is_off_for_a_fresh_install(monkeypatch):
    for f in aifeatures.FEATURES:
        monkeypatch.setattr(config, f["env"], False)
    assert [f["enabled"] for f in aifeatures.state()] == [False] * len(KEYS)


def test_env_setting_decides_when_nothing_is_persisted(monkeypatch):
    monkeypatch.setattr(config, "TITLE_ENABLE", True)
    assert aifeatures.enabled("title") is True


def test_persisted_switch_beats_the_env_setting(monkeypatch):
    monkeypatch.setattr(config, "TITLE_ENABLE", True)
    aifeatures.set_enabled("title", False)
    assert aifeatures.enabled("title") is False


def test_clearing_the_switch_falls_back_to_the_env_setting(monkeypatch):
    monkeypatch.setattr(config, "TITLE_ENABLE", True)
    aifeatures.set_enabled("title", False)
    aifeatures.set_enabled("title", None)
    assert aifeatures.enabled("title") is True


def test_switch_survives_a_reload(monkeypatch):
    aifeatures.set_enabled("nextup", True)
    monkeypatch.setattr(aifeatures, "_cache", None)   # as if the bridge restarted
    assert aifeatures.enabled("nextup") is True


def test_unknown_feature_is_rejected():
    with pytest.raises(ValueError):
        aifeatures.set_enabled("teleportation", True)


def test_unknown_feature_reads_as_off():
    assert aifeatures.enabled("teleportation") is False


def test_every_feature_names_a_real_config_setting():
    for f in aifeatures.FEATURES:
        assert hasattr(config, f["env"]), f["env"]


def test_the_registry_covers_every_model_call_the_bridge_makes():
    """A model call — or a per-run prompt the user is paying for — with no entry
    here is spend they can't see or stop. If a new one is added, register it —
    don't delete this line."""
    assert set(KEYS) == {"title", "relevance", "nextup", "preview", "commitmsg",
                         "learn", "tailstate", "ponytail", "graph", "design",
                         "flows", "flowtype"}


def test_shipped_defaults_are_off_for_anything_automatic():
    """Automatic features ship off; the press-to-run ones ship on, and so do the
    two that shaped every run before this tab existed (ponytail, the project
    map) — listing them is about making that spend visible and stoppable, not
    about changing what a fresh install does.

    Read out of the source rather than from config's attributes: those reflect
    whatever .env this machine has, and reloading the module to clear that takes
    the rest of the suite down with it."""
    with open(config.__file__, encoding="utf-8") as f:
        src = f.read()
    shipped = {"TITLE_ENABLE": "0", "RELEVANCE_CHECK": "0", "NEXTUP_ENABLE": "0",
               "PREVIEW_DETECT_AI": "0", "COMMIT_MSG_AI": "1", "LEARN_ENABLE": "0",
               "TAIL_STATE_AI": "0", "PONYTAIL_ENABLE": "1", "GRAPH_ENABLE": "1",
               "DESIGN_SYNC_ENABLE": "1", "FLOWS_ENABLE": "1",
               "FLOWTYPE_ENABLE": "0"}
    assert set(shipped) == {f["env"] for f in aifeatures.FEATURES}
    for var, default in shipped.items():
        assert f'os.environ.get("{var}", "{default}")' in src, f"{var} ships wrong"


def test_design_switch_reads_its_env_setting(monkeypatch):
    monkeypatch.setattr(config, "DESIGN_SYNC_ENABLE", False)
    assert aifeatures.enabled("design") is False
    monkeypatch.setattr(config, "DESIGN_SYNC_ENABLE", True)
    assert aifeatures.enabled("design") is True
