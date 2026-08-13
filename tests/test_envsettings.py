"""bridge.envsettings — the rest of config.py, made editable from the SYSTEM tab.

What matters: precedence (saved > env > code default), that a saved value
actually lands on `config` so the next turn sees it, that clearing falls back to
what .env said, that bad input is refused before it is persisted, and that the
override file can't move itself out from under its own BRIDGE_DB setting.
Run: python -m pytest tests/test_envsettings.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, config, envsettings  # noqa: E402

KEYS = [s["key"] for s in envsettings.SETTINGS]


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    """Its own settings file per test, and `config` put back afterwards — apply()
    writes straight onto that module, which monkeypatch can't undo for us."""
    base = dict(envsettings._BASE)
    base["BRIDGE_DB"] = str(tmp_path / "bridge.db")
    monkeypatch.setattr(envsettings, "_BASE", base)
    monkeypatch.setattr(envsettings, "_cache", None)
    attrs = [s.get("attr", s["key"]) for s in envsettings.SETTINGS] + ["API", "UPLOAD_DIR"]
    saved = {a: getattr(config, a) for a in attrs}
    yield
    for a, v in saved.items():
        setattr(config, a, v)
    monkeypatch.setattr(envsettings, "_cache", None)


def test_a_fresh_install_reports_env_or_default_for_everything():
    for row in envsettings.state():
        assert row["source"] in ("env", "default"), row["key"]


def test_a_saved_value_lands_on_config():
    envsettings.set_value("RUN_TIMEOUT", 600)
    assert config.RUN_TIMEOUT == 600
    assert envsettings.get("RUN_TIMEOUT") == 600


def test_a_saved_value_beats_the_environment():
    envsettings._BASE["AUTO_RESUME"] = True
    envsettings.set_value("AUTO_RESUME", False)
    assert config.AUTO_RESUME is False
    assert [r for r in envsettings.state() if r["key"] == "AUTO_RESUME"][0]["source"] == "saved"


def test_clearing_falls_back_to_what_env_said():
    envsettings._BASE["RUN_TIMEOUT"] = 1800
    envsettings.set_value("RUN_TIMEOUT", 600)
    envsettings.set_value("RUN_TIMEOUT", None)
    assert config.RUN_TIMEOUT == 1800
    assert [r for r in envsettings.state() if r["key"] == "RUN_TIMEOUT"][0]["source"] != "saved"


def test_a_saved_value_survives_a_restart(monkeypatch):
    envsettings.set_value("NEXTUP_DAYS", 21)
    monkeypatch.setattr(envsettings, "_cache", None)   # as if the bridge restarted
    envsettings.apply()
    assert config.NEXTUP_DAYS == 21


def test_the_override_file_does_not_follow_its_own_bridge_db_setting(tmp_path):
    """BRIDGE_DB is settable from here, so if this file lived beside the *live*
    DB, saving a new one would strand every setting on the next boot."""
    before = envsettings._path()
    envsettings.set_value("BRIDGE_DB", str(tmp_path / "moved" / "other.db"))
    assert config.BRIDGE_DB.endswith("other.db")
    assert envsettings._path() == before
    assert json.load(open(before))["BRIDGE_DB"].endswith("other.db")


def test_unknown_setting_is_rejected():
    with pytest.raises(ValueError):
        envsettings.set_value("TELEPORTATION", "on")


@pytest.mark.parametrize("key,bad", [
    ("RUN_TIMEOUT", "soon"),                     # not a number
    ("RUN_TIMEOUT", 5),                          # under the floor
    ("DASH_PORT", 70000),                        # over the ceiling
    ("NEW_SESSION_PERMISSION_MODE", "yolo"),     # outside the enum
    ("ALLOWED_CHAT_IDS", "me,you"),              # not numbers
])
def test_bad_input_is_refused_before_it_is_persisted(key, bad):
    with pytest.raises(ValueError):
        envsettings.set_value(key, bad)
    assert not os.path.exists(envsettings._path()) or key not in json.load(open(envsettings._path()))


def test_a_corrupt_saved_value_falls_back_instead_of_crashing_boot(monkeypatch):
    envsettings._BASE["RUN_TIMEOUT"] = 1800
    os.makedirs(os.path.dirname(envsettings._path()), exist_ok=True)
    with open(envsettings._path(), "w") as f:
        json.dump({"RUN_TIMEOUT": "not-a-number"}, f)
    monkeypatch.setattr(envsettings, "_cache", None)
    envsettings.apply()
    assert config.RUN_TIMEOUT == 1800


def test_derived_values_are_recomputed_together():
    envsettings.set_value("TELEGRAM_BOT_TOKEN", "123:abc")
    assert config.API.endswith("/bot123:abc")
    envsettings.set_value("BASE_PATH", "/tmp/somewhere")
    assert config.UPLOAD_DIR == "/tmp/somewhere/.bridge_uploads"


def test_a_secret_is_never_returned_in_full():
    envsettings.set_value("TELEGRAM_BOT_TOKEN", "1234567890:SUPERSECRETVALUE")
    row = [r for r in envsettings.state() if r["key"] == "TELEGRAM_BOT_TOKEN"][0]
    assert "SUPERSECRET" not in json.dumps(envsettings.state())
    assert row["value"] == "…ALUE"


def test_the_file_is_not_world_readable():
    envsettings.set_value("TELEGRAM_BOT_TOKEN", "123:abc")
    assert oct(os.stat(envsettings._path()).st_mode)[-3:] == "600"


def test_every_setting_names_a_real_config_attribute():
    for s in envsettings.SETTINGS:
        assert hasattr(config, s.get("attr", s["key"])), s["key"]


def test_no_setting_has_two_switches():
    """A value the AI tab already owns must not also appear here, or the two
    would disagree about which persisted answer wins."""
    assert not {s["key"] for s in envsettings.SETTINGS} & {f["env"] for f in aifeatures.FEATURES}


def test_every_env_var_config_reads_has_a_home():
    """The point of this module: nothing configurable is reachable only by
    whoever deployed the bridge. A new env var in config.py belongs in this
    registry, in the AI tab, or on the short list of things with a UI already."""
    import re
    src = open(config.__file__, encoding="utf-8").read()
    read = set(re.findall(r'os\.environ\.get\("([A-Z_]+)"', src))
    covered = set(KEYS) | {f["env"] for f in aifeatures.FEATURES} | {
        "FALLBACK_POLICY",     # ACCOUNTS tab (ladder.default_policy)
    }
    assert read - covered == set(), f"no way to set these outside .env: {read - covered}"


def test_every_registry_entry_is_described():
    for s in envsettings.SETTINGS:
        assert s["hint"] and s["about"] and s["label"] and s["group"]
        assert s["type"] in ("bool", "int", "str", "text", "path", "enum", "csvint", "secret")
        if s["type"] == "enum":
            assert s.get("choices")


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))


# --- the dashboard's HTTP surface --------------------------------------------
# Driven without sockets via Handler.__new__ (mirrors test_fallback_endpoints.py).

def _handler():
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_get_lists_every_setting():
    h, box = _handler()
    h._get_api("/local/envsettings", {})
    assert box["code"] == 200
    assert [r["key"] for r in box["obj"]["settings"]] == KEYS


def test_post_saves_and_answers_with_the_fresh_list():
    h, box = _handler()
    h._post_api("/local/envsettings", {"key": "RUN_TIMEOUT", "value": 900})
    assert box["code"] == 200 and box["obj"]["ok"] is True
    assert config.RUN_TIMEOUT == 900
    row = [r for r in box["obj"]["settings"] if r["key"] == "RUN_TIMEOUT"][0]
    assert row["value"] == 900 and row["source"] == "saved"


def test_post_with_a_null_value_clears_the_override():
    envsettings._BASE["RUN_TIMEOUT"] = 1800
    envsettings.set_value("RUN_TIMEOUT", 900)
    h, box = _handler()
    h._post_api("/local/envsettings", {"key": "RUN_TIMEOUT", "value": None})
    assert box["code"] == 200 and config.RUN_TIMEOUT == 1800


def test_post_rejects_bad_input_with_400_and_changes_nothing():
    before = config.DASH_PORT
    h, box = _handler()
    h._post_api("/local/envsettings", {"key": "DASH_PORT", "value": 70000})
    assert box["code"] == 400 and "error" in box["obj"]
    assert config.DASH_PORT == before


def test_post_rejects_an_unknown_key_with_400():
    h, box = _handler()
    h._post_api("/local/envsettings", {"key": "TELEPORTATION", "value": "on"})
    assert box["code"] == 400
