"""Claude Code plugins: the marketplaces configured on this machine, and the
plugins installed from them.

A catalog skill (bridge/skills.py) is a single SKILL.md we download ourselves,
which is why the catalog can only carry single-file skills — a SKILL.md that
cites `mocking.md` next to it installs broken. A plugin is the whole bundle:
multi-file skills, agents, MCP servers, a version and an update path. Claude
Code already implements all of that, so this shells out to its own
`claude plugin` CLI rather than reimplementing any of it, and an install from
the dashboard is byte-identical to one typed in a terminal.

Every read is the CLI's own `--json`; every failure is its stderr, verbatim.
There is no second source of truth here, and nothing is cached — the CLI owns
the state, we only ever ask it.
"""

import json
import subprocess

from bridge.runner import claude_bin

# `marketplace add` clones a repo, so this is minutes-scale in the worst case,
# not the seconds a read takes.
_TIMEOUT = 120

SCOPES = ("user", "project", "local")


def _run(*args: str) -> "tuple[int, str, str]":
    try:
        p = subprocess.run([claude_bin(), "plugin", *args],
                           capture_output=True, text=True, timeout=_TIMEOUT)
    except FileNotFoundError:
        return 127, "", "claude not found on PATH"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as e:
        return 1, "", str(e)
    return p.returncode, p.stdout, p.stderr


def _read(*args: str):
    """A `--json` read. Any failure — CLI missing, bad exit, unparseable — is an
    empty result: the panel shows nothing rather than breaking the page."""
    rc, out, _ = _run(*args)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def _act(*args: str) -> "tuple[bool, str]":
    rc, out, err = _run(*args)
    if rc == 0:
        return True, ""
    return False, (err.strip() or out.strip() or f"exit {rc}").splitlines()[-1][:300]


def _arg(value: str) -> "str | None":
    """A name that reaches argv. Nothing is shell-interpolated, so the only real
    hazard is a leading dash being read as a flag."""
    v = (value or "").strip()
    if not v or v.startswith("-") or len(v) > 200:
        return None
    return v


def listing() -> dict:
    """Marketplaces, plugins installed from them, and what else they offer.

    Two calls: `list --available` returns installed and available together."""
    both = _read("list", "--available", "--json") or {}
    return {
        "marketplaces": _read("marketplace", "list", "--json") or [],
        "installed": [
            {"id": p.get("id"), "version": p.get("version"), "scope": p.get("scope"),
             "enabled": bool(p.get("enabled")), "mcp": sorted(p.get("mcpServers") or {})}
            for p in both.get("installed") or [] if p.get("id")
        ],
        "available": [
            {"id": p.get("pluginId"), "name": p.get("name"),
             "description": (p.get("description") or "")[:400],
             "marketplace": p.get("marketplaceName")}
            for p in both.get("available") or [] if p.get("pluginId")
        ],
    }


def add_marketplace(source: str) -> "tuple[bool, str]":
    """`source` is a GitHub `owner/repo`, a URL, or a local path."""
    s = _arg(source)
    return _act("marketplace", "add", s) if s else (False, "invalid source")


def remove_marketplace(name: str) -> "tuple[bool, str]":
    n = _arg(name)
    return _act("marketplace", "remove", n) if n else (False, "invalid name")


def install(plugin: str, scope: str = "user") -> "tuple[bool, str]":
    p = _arg(plugin)
    if not p:
        return False, "invalid plugin"
    if scope not in SCOPES:
        return False, "invalid scope"
    return _act("install", p, "--scope", scope)


def uninstall(plugin: str) -> "tuple[bool, str]":
    p = _arg(plugin)
    return _act("uninstall", p) if p else (False, "invalid plugin")


def set_enabled(plugin: str, enabled: bool) -> "tuple[bool, str]":
    p = _arg(plugin)
    if not p:
        return False, "invalid plugin"
    return _act("enable" if enabled else "disable", p)


def update(plugin: str) -> "tuple[bool, str]":
    p = _arg(plugin)
    return _act("update", p) if p else (False, "invalid plugin")
