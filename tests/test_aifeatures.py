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
    monkeypatch.setattr(config, "MEMORY_ENABLE", True)
    assert aifeatures.enabled("memory") is True


def test_persisted_switch_beats_the_env_setting(monkeypatch):
    monkeypatch.setattr(config, "MEMORY_ENABLE", True)
    aifeatures.set_enabled("memory", False)
    assert aifeatures.enabled("memory") is False


def test_clearing_the_switch_falls_back_to_the_env_setting(monkeypatch):
    monkeypatch.setattr(config, "MEMORY_ENABLE", True)
    aifeatures.set_enabled("memory", False)
    aifeatures.set_enabled("memory", None)
    assert aifeatures.enabled("memory") is True


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
