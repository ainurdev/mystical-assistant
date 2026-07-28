"""cloudflared reads TUNNEL_* env vars as CLI flags, and run.sh exports every
.env key — so our TUNNEL_ID/TUNNEL_NAME silently became `--id`/`--name` and
turned the Mini App's quick tunnel into a named-tunnel run that dies on a
missing origin cert. The child env must be scrubbed.
Run: python tests/test_tunnel_env.py"""
import os

from bridge import tunnel


class _FakeProc:
    """Emits the line each spawner watches for, so neither waits out its timeout."""

    def __init__(self, lines):
        self.stdout = iter(lines)

    def poll(self):
        return None

    def terminate(self):
        pass


def _spy_popen(seen, lines):
    def popen(argv, **kw):
        seen["env"] = kw.get("env")
        return _FakeProc(lines)
    return popen


def test_quick_tunnel_child_env_has_no_tunnel_vars(monkeypatch):
    monkeypatch.setenv("TUNNEL_ID", "612b1ee2")
    monkeypatch.setenv("TUNNEL_NAME", "mystical-preview")
    monkeypatch.setenv("TUNNEL_CREDENTIALS_FILE", "/home/u/.cloudflared/x.json")
    seen = {}
    monkeypatch.setattr(tunnel.subprocess, "Popen",
                        _spy_popen(seen, ["https://x-y-z.trycloudflare.com\n"]))

    tunnel._spawn_tunnel(8787)

    env = seen["env"]
    assert env is not None, "quick tunnel inherited the bridge env verbatim"
    assert not [k for k in env if k.startswith("TUNNEL_")], \
        f"TUNNEL_* leaked to cloudflared: {[k for k in env if k.startswith('TUNNEL_')]}"


def test_named_tunnel_child_env_has_no_tunnel_vars(monkeypatch, tmp_path):
    monkeypatch.setenv("TUNNEL_NAME", "mystical-preview")
    monkeypatch.setattr(tunnel, "_write_config", lambda port: str(tmp_path / "c.yml"))
    monkeypatch.setattr(tunnel, "_EDGE_SETTLE", 0)
    seen = {}
    monkeypatch.setattr(tunnel.subprocess, "Popen",
                        _spy_popen(seen, ["INF Registered tunnel connection\n"]))

    tunnel._spawn_named(8080)

    assert not [k for k in seen["env"] if k.startswith("TUNNEL_")]


def test_scrub_keeps_the_rest_of_the_environment(monkeypatch):
    monkeypatch.setenv("TUNNEL_ID", "abc")
    monkeypatch.setenv("PATH", "/usr/bin")
    env = tunnel._cf_env()
    assert "TUNNEL_ID" not in env
    assert env["PATH"] == "/usr/bin"   # cloudflared still needs a working env


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
