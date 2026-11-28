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
                         "learn", "dream", "ponytail", "designpack", "graph",
                         "rvtrack", "changelog", "logostyle",
                         "router", "autopick", "nextstep",
                         "smartzone", "grillcards", "ticketruns", "ticketapprove", "mergereview",
                         "translate", "explain", "design_critic", "refine"}


def test_state_carries_the_parent_of_a_sub_switch():
    """The AI tab nests a sub-switch under its parent from this field alone."""
    parents = {f["key"]: f.get("parent") for f in aifeatures.state()}
    assert parents["autopick"] == "router"
    assert parents["mergereview"] == parents["ticketapprove"] == "ticketruns"
    assert parents["router"] is None and parents["grillcards"] is None


def test_shipped_defaults_are_off_for_anything_automatic():
    """Automatic features ship off; the press-to-run ones ship on, and so do the
    two that shaped every run before this tab existed (ponytail, the project
    map) — listing them is about making that spend visible and stoppable, not
    about changing what a fresh install does. The skill router's
    sub-switches ship on too, but they obey SKILL ROUTER, which ships off.

    Read out of the source rather than from config's attributes: those reflect
    whatever .env this machine has, and reloading the module to clear that takes
    the rest of the suite down with it."""
    with open(config.__file__, encoding="utf-8") as f:
        src = f.read()
    shipped = {"TITLE_ENABLE": "0", "RELEVANCE_CHECK": "0", "NEXTUP_ENABLE": "0",
               "PREVIEW_DETECT_AI": "0", "TRANSLATE_ENABLE": "1", "EXPLAIN_ENABLE": "1", "REFINE_ENABLE": "1", "DESIGN_CRITIC_ENABLE": "1", "COMMIT_MSG_AI": "1", "LEARN_ENABLE": "0",
               "DREAM_ENABLE": "0",
               "PONYTAIL_ENABLE": "1", "DESIGN_PACK_ENABLE": "0", "GRAPH_ENABLE": "1",
               "RIVENDELL_TRACK": "1", "CHANGELOG_ENABLE": "1",
               "LOGO_STYLE_AI": "1",
               "ROUTER_ENABLE": "0", "ROUTER_AUTO": "1",
               "ROUTER_NEXT": "1", "ROUTER_ZONE": "1",
               "GRILL_CARDS": "0", "TICKET_RUNS": "0", "TICKET_APPROVE": "0",
               "MERGE_REVIEW": "1"}      # on, but it obeys TICKETS, which ships off
    assert set(shipped) == {f["env"] for f in aifeatures.FEATURES}
    for var, default in shipped.items():
        assert f'os.environ.get("{var}", "{default}")' in src, f"{var} ships wrong"


def test_a_saved_file_with_removed_switches_loads_without_them(tmp_path):
    (tmp_path / "ai_features.json").write_text('{"askmatt": false, "setupnudge": true, "tickets": true, "nextup": true}')
    assert aifeatures.enabled("nextup") is True
    assert aifeatures.enabled("askmatt") is False
