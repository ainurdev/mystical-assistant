"""Each AI tool's own global config, edited from the dashboard instead of from a
terminal on the machine the bridge runs on.

Claude Code reads user-wide instructions from ~/.claude/CLAUDE.md and user
settings from ~/.claude/settings.json; opencode — the free-agent rung — keeps
the same pair under ~/.config/opencode. Those are the tools' own files in the
tools' own formats, so this module persists nothing of its own and layers
nothing the way `envsettings` layers over .env: it reads and writes them
verbatim, and whatever else edits them (Claude Code's /config, an editor, the
tool itself) stays as valid a source of truth as this tab. Nothing is cached
either — a file changed on disk between two GETs is simply what the second GET
returns.

A fixed registry, not a path parameter. The dashboard is localhost plus a
token, but "write any file under $HOME" is not an endpoint worth having when
four paths cover the need; an id outside FILES raises, and never becomes a path.

Two guards, both about not destroying the file you were only trying to edit: a
.json file is parsed before it lands (one trailing comma silently voids every
setting in settings.json, and the editor that made the typo is the last place
that can catch it), and a write follows a symlink to its target rather than
replacing it — account slots symlink *to* ~/.claude/CLAUDE.md, and a dotfiles
setup may point that at somewhere else again.

Stdlib only.
"""

import json
import os

from bridge import accounts, freeagent

# Nothing here is a big file; the cap exists so a broken client can't post a
# gigabyte, and so an unreadable-because-enormous file is reported rather than
# silently truncated into the editor and saved back short.
MAX_BYTES = 1_000_000

# tool -- which entry in TOOLS owns it; also picks the directory it lives in
# lang -- markdown | json. json is parsed before it is written.
FILES = (
    {"id": "claude.memory", "tool": "claude", "name": "CLAUDE.md", "lang": "markdown",
     "hint": "instructions every project inherits, ahead of its own CLAUDE.md"},
    {"id": "claude.settings", "tool": "claude", "name": "settings.json", "lang": "json",
     "hint": "model, permission mode, hooks, env — Claude Code's user settings"},
    {"id": "opencode.memory", "tool": "opencode", "name": "AGENTS.md", "lang": "markdown",
     "hint": "instructions every opencode run inherits"},
    {"id": "opencode.settings", "tool": "opencode", "name": "opencode.json", "lang": "json",
     "hint": "providers, models and permissions for opencode"},
)

TOOLS = (
    {"id": "claude", "label": "CLAUDE CODE", "hint": "what every session on this bridge runs"},
    {"id": "opencode", "label": "OPENCODE", "hint": "the free-agent fallback rung"},
)


def _opencode_home() -> str:
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
                        "opencode")


def _entry(fid: str) -> dict:
    for f in FILES:
        if f["id"] == fid:
            return f
    raise ValueError(f"unknown config file {fid!r}")


def path_of(fid: str) -> str:
    f = _entry(fid)
    # accounts.CLAUDE_HOME rather than a second ~/.claude constant: slot 1 *is*
    # that directory, and repointing it should move this tab with it.
    root = accounts.CLAUDE_HOME if f["tool"] == "claude" else _opencode_home()
    return os.path.join(root, f["name"])


def _tilde(p: str) -> str:
    home = os.path.expanduser("~")
    return "~" + p[len(home):] if p.startswith(home + os.sep) else p


def _file_state(f: dict) -> dict:
    path = path_of(f["id"])
    content, error = "", None
    try:
        with open(path, encoding="utf-8") as fh:
            content = fh.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            # Reported, not truncated: handing back a short copy invites a save
            # that eats the rest of the file.
            content, error = "", "too large to edit here"
    except FileNotFoundError:
        pass                       # not written yet; saving creates it
    except (OSError, UnicodeDecodeError) as e:
        error = str(e)
    return {"id": f["id"], "name": f["name"], "lang": f["lang"], "hint": f["hint"],
            "path": _tilde(path), "exists": os.path.exists(path),
            "content": content, "error": error}


def state() -> dict:
    """Every installed tool with its config files, contents included — they are
    a few KB each, so the whole tab is one GET."""
    tools = []
    for t in TOOLS:
        # The bridge is a Claude Code launcher: there is nothing to detect for
        # claude, and a missing opencode means its files aren't worth creating.
        installed = t["id"] == "claude" or bool(freeagent.opencode_bin())
        tools.append({**t, "installed": installed,
                      "files": [_file_state(f) for f in FILES if f["tool"] == t["id"]]
                               if installed else []})
    return {"tools": tools}


def write(fid: str, content: str) -> None:
    """Save one config file. Raises ValueError on an unknown id, content over
    MAX_BYTES, or JSON that would not parse."""
    f = _entry(fid)
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise ValueError("too large")
    if f["lang"] == "json":
        try:
            json.loads(content)
        except ValueError as e:
            raise ValueError(f"not valid JSON — {e}") from None
    path = os.path.realpath(path_of(fid))     # write through a symlink, not over it
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.replace(tmp, path)
