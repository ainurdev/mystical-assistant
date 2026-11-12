import os
from unittest import mock

from bridge import screenshot


def test_the_newest_chrome_is_found_whatever_the_platform_names_its_folder(tmp_path, monkeypatch):
    """Playwright names the folder inside a build after the platform (-linux64,
    -mac-arm64); looking for one of those names found nothing on the other."""
    for build, inner in (("1243", "chrome-headless-shell-linux64"), ("1248", "chrome-headless-shell-mac-arm64")):
        d = tmp_path / ".cache" / "ms-playwright" / f"chromium_headless_shell-{build}" / inner
        d.mkdir(parents=True)
        (d / "chrome-headless-shell").write_text("")
    monkeypatch.setattr(screenshot, "_GLOB", screenshot._GLOB.replace(os.path.expanduser("~"), str(tmp_path)))
    assert screenshot._installed_chrome().endswith(
        os.path.join("chromium_headless_shell-1248", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"))


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
