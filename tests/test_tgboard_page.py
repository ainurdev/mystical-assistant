"""The widget pages (bridge/widgets/): Telegram's limits on each page, and the Node
checks of their scripts (tests/widgets/*.check.mjs, one file per ticket), skipped
without Node."""

import glob
import os
import re
import shutil
import subprocess
import zlib

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = sorted(glob.glob(os.path.join(ROOT, "bridge", "widgets", "*.html")))
CHECKS = sorted(glob.glob(os.path.join(ROOT, "tests", "widgets", "*.check.mjs")))


@pytest.mark.parametrize("page", PAGES, ids=os.path.basename)
def test_a_page_keeps_inside_telegrams_limits(page):
    raw = open(page, "rb").read()
    assert len(raw) <= 32768
    assert len(zlib.compress(raw, 9)) <= 4096
    text = raw.decode()
    assert not re.search(r"https?:|//[a-z]|@import|url\(", text, re.I), "loads nothing from outside"
    assert "@font-face" not in text
    assert not re.search(r"<(input|button|select|textarea|form)\b", text, re.I), "Telegram strips form controls"
    assert "var(--tg-theme-text-color)" in text and "system-ui" in text


@pytest.mark.parametrize("check", CHECKS, ids=os.path.basename)
def test_the_page_script_checks(check):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    r = subprocess.run([node, check], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
