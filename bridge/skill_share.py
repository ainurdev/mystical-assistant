"""Skills across agents: one folder, seen from every agent's path.

SKILL.md is a shared format, and the difference between agents is where they look.
Mystical installs skills where Claude looks (.claude/skills). Kimi Code reads
.agents/skills and ~/.agents/skills, and its docs don't list .claude/skills. Codex is
reported to read .agents/skills too. So a shared skill is a symlink in the other
directory: no copy to drift, and no CLI's config file edited.

Sharing runs in both directions, so a skill installed only under .agents reaches
Claude. It never overwrites a real file or folder: a name taken on the other side
reads "conflict".

A skill written for Claude can mislead elsewhere. It may tell the agent to call a tool
it doesn't have, and an `allowed-tools` line that limits it on Claude may be ignored
(Kimi's docs don't mention one), which would quietly widen what it can do. Such a skill
reads "claude-only" and stays off until you switch it on by hand. CLAUDE_TOOLS is a
plain text match, so it misses a skill that merely assumes Claude: the switch is there
for that too.

A project's .agents/skills link goes in .git/info/exclude, so it never shows in git
status. Choices live in ~/.mystical/skill-share.json. Stdlib only.
"""

import json
import os
import re
import subprocess
import threading

from bridge import experimental

_FILE = os.path.expanduser(os.environ.get("SKILL_SHARE_FILE", "~/.mystical/skill-share.json"))
_lock = threading.Lock()
_HOME = os.path.expanduser("~")
CLAUDE_TOOLS = re.compile(r"AskUserQuestion|ToolSearch|Agent tool|\bmcp__|TodoWrite|EnterPlanMode|"
                          r"the Skill tool|^allowed-tools\s*:", re.M)


def _roots(cwd: "str | None") -> list:
    """(scope, Claude's dir, the shared dir) for each place skills live."""
    out = [("user", os.path.join(_HOME, ".claude", "skills"), os.path.join(_HOME, ".agents", "skills"))]
    if cwd:
        out.append(("project", os.path.join(cwd, ".claude", "skills"), os.path.join(cwd, ".agents", "skills")))
    return out


def _load() -> dict:
    try:
        with open(_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _skills_in(d: str) -> dict:
    """id -> the real folder, for each skill directly in d (links followed)."""
    out = {}
    try:
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if os.path.isfile(os.path.join(p, "SKILL.md")):
                out[name] = p
    except OSError:
        pass
    return out


def claude_only(path: str) -> bool:
    try:
        with open(os.path.join(path, "SKILL.md"), encoding="utf-8", errors="replace") as f:
            return bool(CLAUDE_TOOLS.search(f.read(200_000)))
    except OSError:
        return False


def _wanted(key: str, restricted: bool, picks: dict) -> bool:
    return bool(picks[key]) if key in picks else not restricted


def _exclude(cwd: str) -> None:
    """Keep a project's .agents/ out of git status, without touching .gitignore."""
    try:
        d = subprocess.run(["git", "-C", cwd, "rev-parse", "--git-path", "info/exclude"],
                           capture_output=True, text=True, timeout=5).stdout.strip()
        if not d:
            return
        path = d if os.path.isabs(d) else os.path.join(cwd, d)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(path, encoding="utf-8") as f:
                if ".agents/skills" in f.read():
                    return
        except OSError:
            pass
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n.agents/skills\n")
    except (OSError, subprocess.SubprocessError):
        pass


def _link(src: str, dst: str) -> bool:
    """dst -> src. False when something real already holds that name."""
    if os.path.lexists(dst):
        return os.path.islink(dst) and os.path.realpath(dst) == os.path.realpath(src)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.symlink(src, dst)
    return True


def _unlink(src: str, dst: str) -> None:
    if os.path.islink(dst) and os.path.realpath(dst) == os.path.realpath(src):
        os.unlink(dst)


def sync(cwd: "str | None") -> None:
    """Make the links match the choices. Called before an agent turn. Best-effort."""
    if not experimental.enabled():
        return
    picks = _load()
    for scope, claude_dir, shared_dir in _roots(cwd):
        for src_dir, dst_dir in ((claude_dir, shared_dir), (shared_dir, claude_dir)):
            for name, path in _skills_in(src_dir).items():
                if os.path.islink(path):
                    continue            # our own link, or one someone made on purpose
                dst = os.path.join(dst_dir, name)
                try:
                    if _wanted(f"{scope}:{name}", claude_only(path), picks):
                        made = not os.path.lexists(dst)
                        if _link(path, dst) and made and scope == "project" and cwd:
                            _exclude(cwd)
                    else:
                        _unlink(path, dst)
                except OSError:
                    pass


def state(cwd: "str | None") -> list:
    """The Settings rows."""
    picks = _load()
    rows = []
    for scope, claude_dir, shared_dir in _roots(cwd):
        for src_dir, dst_dir in ((claude_dir, shared_dir), (shared_dir, claude_dir)):
            for name, path in sorted(_skills_in(src_dir).items()):
                if os.path.islink(path):
                    continue
                restricted = claude_only(path)
                dst = os.path.join(dst_dir, name)
                conflict = os.path.lexists(dst) and not (
                    os.path.islink(dst) and os.path.realpath(dst) == os.path.realpath(path))
                rows.append({"key": f"{scope}:{name}", "name": name, "scope": scope,
                             "home": "claude" if src_dir == claude_dir else "agents",
                             "claude_only": restricted, "conflict": conflict,
                             "on": _wanted(f"{scope}:{name}", restricted, picks)})
    return rows


def set_share(key: str, on: bool, cwd: "str | None") -> None:
    with _lock:
        data = _load()
        data[key] = bool(on)
        os.makedirs(os.path.dirname(_FILE), mode=0o700, exist_ok=True)
        tmp = _FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, _FILE)
    sync(cwd)
