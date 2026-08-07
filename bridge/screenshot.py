"""Headless-Chrome screenshot of a URL, for visual context to Claude.

Uses chrome-headless-shell directly (no Playwright module). In this WSL env Chrome
needs an ALSA stub on LD_LIBRARY_PATH; both are configurable via env.
"""

import glob
import os
import subprocess
import tempfile

_GLOB = os.path.expanduser(
    "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"
)


def _installed_chrome() -> str:
    """Newest local install. Playwright puts its build number in the path and
    bumps it on every update, so the build this used to hardcode went stale
    silently — every capture failing with a not-found on a path nobody reads."""
    def build(p: str) -> int:
        return int(p.split("chromium_headless_shell-")[1].split(os.sep)[0])
    hits = glob.glob(_GLOB)
    return max(hits, key=build) if hits else "chrome-headless-shell"


CHROME = os.environ.get("CHROME_HEADLESS_SHELL") or _installed_chrome()
CHROME_LD = os.environ.get("CHROME_LD_LIBRARY_PATH", os.path.expanduser("~/.cache/ms-playwright"))


def chrome_cmd(url: str, width: int, height: int, out_path: str) -> list[str]:
    return [
        CHROME, "--headless", "--no-sandbox", "--hide-scrollbars",
        "--force-device-scale-factor=1", f"--window-size={width},{height}",
        "--virtual-time-budget=4000", f"--screenshot={out_path}", url,
    ]


def capture(url: str, width: int, height: int = 900, timeout: int = 20) -> bytes:
    env = dict(os.environ)
    if CHROME_LD:
        env["LD_LIBRARY_PATH"] = CHROME_LD + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "shot.png")
        proc = subprocess.run(chrome_cmd(url, width, height, out), env=env,
                              capture_output=True, timeout=timeout)
        if not os.path.exists(out):
            raise RuntimeError(f"screenshot failed (rc={proc.returncode}): {proc.stderr[:300]!r}")
        with open(out, "rb") as f:
            return f.read()
