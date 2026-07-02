"""`.env.example` stays in sync with config.py: every documented var is read by
config, and the required trio is present. Run: python tests/test_env_example.py"""
import os
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _example_keys():
    text = (ROOT / ".env.example").read_text()
    return [m.group(1) for m in re.finditer(r'^([A-Z_]+)=', text, re.M)]


def test_every_example_var_is_read_by_config():
    cfg = (ROOT / "bridge" / "config.py").read_text()
    for key in _example_keys():
        assert f'"{key}"' in cfg, f'{key} in .env.example but not read by config.py'


def test_required_vars_present():
    keys = set(_example_keys())
    assert {"TELEGRAM_BOT_TOKEN", "BASE_PATH", "ALLOWED_CHAT_IDS"} <= keys


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
