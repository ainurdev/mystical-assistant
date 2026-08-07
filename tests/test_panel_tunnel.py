"""The Mini App panel takes the named tunnel (fixed hostname -> its Telegram link
survives restarts) and falls back to a quick one when none is configured.
Run: python tests/test_panel_tunnel.py"""
import os

from bridge import config, tunnel


class _FakeProc:
    def poll(self):
        return None  # "still running"


def _configure_named(monkeypatch, tmp_path):
    cred = tmp_path / "cred.json"
    cred.write_text("{}")
    monkeypatch.setattr(config, "PREVIEW_HOSTNAME", "panel.example.com")
    monkeypatch.setattr(config, "TUNNEL_ID", "abc")
    monkeypatch.setattr(config, "TUNNEL_CREDENTIALS_FILE", str(cred))


def test_panel_uses_named_tunnel_when_configured(monkeypatch, tmp_path):
    _configure_named(monkeypatch, tmp_path)

    def _no_quick(port):
        raise AssertionError("quick tunnel used despite named config")

    monkeypatch.setattr(tunnel, "open_quick_tunnel", _no_quick)
    monkeypatch.setattr(tunnel, "_spawn_named",
                        lambda port: (_FakeProc(), "https://panel.example.com"))

    _, url = tunnel.open_panel_tunnel(8787)
    assert url == "https://panel.example.com"


def test_panel_falls_back_to_quick(monkeypatch, tmp_path):
    """No named tunnel configured, or it fails to register -> quick tunnel, not nothing."""
    _configure_named(monkeypatch, tmp_path)
    monkeypatch.setattr(tunnel, "_spawn_named", lambda port: (None, "no-connection"))
    monkeypatch.setattr(tunnel, "open_quick_tunnel",
                        lambda port: (_FakeProc(), "https://demo.example-tunnel.com"))

    _, url = tunnel.open_panel_tunnel(8787)
    assert url == "https://demo.example-tunnel.com"


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
