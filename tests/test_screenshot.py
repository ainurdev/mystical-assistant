import glob
import os
from unittest import mock

import pytest

from bridge import screenshot


def test_the_installed_chrome_is_found_on_this_platform():
    """Playwright names the folder inside a build after the platform (-linux64,
    -mac-arm64); naming one of them found nothing on the other."""
    if not glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-*")):
        pytest.skip("no headless chrome is installed")
    assert os.path.isfile(screenshot.CHROME)


def test_chrome_cmd_includes_window_size_and_url():
    cmd = screenshot.chrome_cmd("https://preview.test", 375, 900, "/tmp/o.png")
    assert any("--window-size=375,900" in c for c in cmd)
    assert cmd[-1] == "https://preview.test"
    assert any("--screenshot=/tmp/o.png" in c for c in cmd)


def test_capture_runs_chrome_and_returns_bytes(tmp_path):
    png = b"\x89PNG\r\n\x1a\n-fake"

    def fake_run(cmd, **kw):
        # find the --screenshot=… arg and write the fake PNG
        for c in cmd:
            if c.startswith("--screenshot="):
                with open(c.split("=", 1)[1], "wb") as f:
                    f.write(png)
        return mock.Mock(returncode=0, stderr=b"")

    with mock.patch("subprocess.run", side_effect=fake_run):
        data = screenshot.capture("https://preview.test", 375)
    assert data == png
