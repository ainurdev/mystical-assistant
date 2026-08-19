"""The `/name` commands a prompt can start with — what the composers offer when
you type `/`, the way the CLI's own input does.

`claude -p "/name args"` resolves a name the same way an interactive session
does (skills, custom commands, plugins, built-ins), so nothing here *runs*
anything: this only enumerates what would resolve, for autocomplete. Sources,
in the order a name is claimed:

- project + user skills: `<project>/.claude/skills/*/SKILL.md`, `~/.claude/skills/*/SKILL.md`
- project + user commands: `.claude/commands/**/*.md` — the file's stem is the
  name; a subdirectory is organisation only (what the CLI does)
- enabled plugins, as `plugin:name`: `~/.claude/plugins/installed_plugins.json`
  says where each is checked out, `enabledPlugins` in user + project settings
  says which count; each contributes `skills/*` and `commands/*.md`
- BUILTIN: the skills bundled inside the CLI binary. They can't be scanned, so
  this is a static list (see the note on it)

Read straight off disk on every call — a few dozen small files — rather than
shelling out to `claude plugin list` (seconds) or caching (would miss the skill
you just installed from the SKILLS tab). Best-effort throughout: anything
unreadable or malformed contributes nothing, never an error.
"""

import json
import os

from bridge.skills import _front_matter

USER_DIR = os.path.expanduser("~/.claude")

# ponytail: the CLI's bundled skills live inside its binary, so they're listed by
# hand from a 2.1.x session's skill list. Re-check when the CLI updates; a stale
# entry costs one "unknown skill" reply, a missing one costs one autocomplete row.
BUILTIN = (
    ("compact", "Compact the conversation to reclaim context — add instructions to steer what the summary keeps"),
    ("init", "Write a CLAUDE.md for this project"),
    ("code-review", "Review the current diff (or a PR/branch) for bugs and cleanups"),
    ("simplify", "Review the changed code for reuse, simplification and efficiency, then apply the fixes"),
    ("security-review", "Security review of the pending changes on the current branch"),
    ("loop", "Run a prompt or slash command on a recurring interval"),
    ("schedule", "Create, update, list or run scheduled cloud agents"),
    ("run", "Launch and drive this project's app to see a change working"),
    ("claude-api", "Claude API / Anthropic SDK reference — models, pricing, params, tool use"),
    ("fewer-permission-prompts", "Add a prioritized allowlist to settings from your transcripts"),
    ("update-config", "Configure the Claude Code harness via settings.json"),
)
_DESC_MAX = 200


def _read(path: str, n: int = 4096) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(n)
    except OSError:
        return ""


def _skills(root: str) -> "list[tuple[str, str]]":
    """(name, description) for every `root/<dir>/SKILL.md`; front-matter name
    wins over the directory, as the CLI resolves it."""
    out = []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return out
    for n in names:
        md = os.path.join(root, n, "SKILL.md")
        if not os.path.isfile(md):
            continue
        fm = _front_matter(_read(md))
        out.append((fm.get("name") or n, fm.get("description") or ""))
    return out


def _commands(root: str) -> "list[tuple[str, str]]":
    """(name, description) for every `.md` under root, any depth. Description
    is the front-matter one, else the prompt's first line — the CLI's rule."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for fn in sorted(filenames):
            if not fn.endswith(".md"):
                continue
            text = _read(os.path.join(dirpath, fn))
            fm = _front_matter(text)
            desc = fm.get("description") or _first_line(text)
            out.append((fn[:-3], desc))
    return out


def _first_line(text: str) -> str:
    body = text
    if text.lstrip().startswith("---"):
        _, _, body = text.lstrip()[3:].partition("\n---")
    for line in body.splitlines():
        if line.strip():
            return line.strip()
    return ""


def _json(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _enabled_plugins(abs_project: "str | None") -> "set[str]":
    """Plugin ids switched on — user settings, then the project's on top."""
    on = {}
    for p in (os.path.join(USER_DIR, "settings.json"),
              os.path.join(abs_project, ".claude", "settings.json") if abs_project else ""):
        s = _json(p) if p else None
        if isinstance(s, dict) and isinstance(s.get("enabledPlugins"), dict):
            on.update(s["enabledPlugins"])
    return {pid for pid, v in on.items() if v}


def _plugin_roots(abs_project: "str | None") -> "list[tuple[str, str]]":
    """(short name, install dir) for each enabled plugin. The registry keeps a
    list of installs per id (one per scope); the v1 shape was a single dict."""
    reg = _json(os.path.join(USER_DIR, "plugins", "installed_plugins.json"))
    plugins = reg.get("plugins") if isinstance(reg, dict) else None
    if not isinstance(plugins, dict):
        return []
    on = _enabled_plugins(abs_project)
    out = []
    for pid, entries in plugins.items():
        if pid not in on:
            continue
        for e in entries if isinstance(entries, list) else [entries]:
            path = e.get("installPath") if isinstance(e, dict) else None
            if path:
                out.append((pid.split("@")[0], path))
    return out


def available(abs_project: "str | None" = None) -> "list[dict]":
    """Every `/name` the next prompt could start with, each once, first claim
    wins: project, user, plugins, then the bundled list."""
    sources = []
    for scope, root in (("project", os.path.join(abs_project, ".claude") if abs_project else None),
                        ("user", USER_DIR)):
        if root:
            sources.append((scope, _skills(os.path.join(root, "skills")) + _commands(os.path.join(root, "commands"))))
    for short, path in _plugin_roots(abs_project):
        found = _skills(os.path.join(path, "skills")) + _commands(os.path.join(path, "commands"))
        sources.append(("plugin", [(f"{short}:{n}", d) for n, d in found]))
    sources.append(("builtin", list(BUILTIN)))

    seen, out = set(), []
    for scope, pairs in sources:
        for name, desc in pairs:
            if name and name not in seen:
                seen.add(name)
                out.append({"name": name, "description": desc[:_DESC_MAX], "scope": scope})
    return out
