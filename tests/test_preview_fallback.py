"""/preview falls back to an ephemeral quick tunnel when no named tunnel is
configured, and uses the named tunnel when one is. Run: python tests/test_preview_fallback.py"""
import os

from bridge import config, tunnel


class _FakeProc:
    def poll(self):
        return None  # "still running"


def _reset_globals(monkeypatch):
    monkeypatch.setattr(tunnel, "_tunnel_proc", None)
    monkeypatch.setattr(tunnel, "_tunnel_url", None)
    monkeypatch.setattr(tunnel, "_tunnel_port", None)


def test_quick_tunnel_when_unconfigured(monkeypatch):
    monkeypatch.setattr(config, "PREVIEW_HOSTNAME", "")
    monkeypatch.setattr(config, "TUNNEL_ID", "")
    _reset_globals(monkeypatch)

    def _no_named(port):
        raise AssertionError("named tunnel used despite empty config")

    monkeypatch.setattr(tunnel, "_spawn_named", _no_named)
    monkeypatch.setattr(tunnel, "open_quick_tunnel",
                        lambda port: (_FakeProc(), "https://demo.trycloudflare.com"))

    url, msg = tunnel.start_tunnel(4000)
    assert url == "https://demo.trycloudflare.com"
    assert "trycloudflare.com" in msg


def test_named_tunnel_when_configured(monkeypatch, tmp_path):
    cred = tmp_path / "cred.json"
    cred.write_text("{}")
    monkeypatch.setattr(config, "PREVIEW_HOSTNAME", "preview.example.com")
    monkeypatch.setattr(config, "TUNNEL_ID", "abc")
    monkeypatch.setattr(config, "TUNNEL_CREDENTIALS_FILE", str(cred))
    _reset_globals(monkeypatch)

    def _no_quick(port):
        raise AssertionError("quick tunnel used despite named config")

    monkeypatch.setattr(tunnel, "open_quick_tunnel", _no_quick)
    monkeypatch.setattr(tunnel, "_spawn_named",
                        lambda port: (_FakeProc(), "https://preview.example.com"))

    url, msg = tunnel.start_tunnel(4000)
    assert url == "https://preview.example.com"


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
