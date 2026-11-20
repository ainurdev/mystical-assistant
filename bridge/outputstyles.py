"""Output styles: Claude Code's own `outputStyle` setting, picked per session like effort.

A style changes how Claude answers you (its voice, its length, what it explains), not how
the dashboard draws a reply. Mystical passes it per run in the one --settings
(runner._run_streaming), never as /output-style, which writes the folder's
.claude/settings.local.json. --settings beats the project's and the user's own settings,
so a pick wins in its session; Not set passes nothing, and the folder's own setting
decides (~/Projects/communication runs its Comms style that way).

Which style a turn takes: a lit flow's (its prompt carries it), else the session's own
pick, else its profile's (profiles.effective), else none.

Only chats you drive take one (ATTENDED). Learning leaves a TODO(human) and waits for
you: in a Part, a helper or an automation nobody watches, its flow could merge the
half-written code. An allowlist, so an origin added later runs unstyled until someone
decides otherwise. Internal one-shots (titles, commit messages, scouts, Council
reviewers) never get one either: they run with skip_pack or through run_blocking.

What a picker offers (available): the CLI's built-ins, then the custom styles in
~/.claude/output-styles and in each folder's .claude/output-styles from the session's
folder up to its repo root, the nearest one winning a name. Plugin and managed styles
aren't listed: none are installed. A name the CLI doesn't know runs as Default, so a pick
is checked only for shape (clean), never looked up: a profile or a flow isn't tied to one
folder's custom styles.

Stdlib only.
"""

import os
import re

from bridge import skills

# The CLI's built-ins: the id is what `outputStyle` takes, case and all (Default is
# lowercase there); the hint is the CLI's own description, shortened.
# shortcut: copied from Claude Code 2.1.328's list, update it when the CLI adds or renames one.
BUILT_IN = (
    ("default", "Default", "Claude's usual way of working"),
    ("Proactive", "Proactive", "acts at once, interrupts less, prefers action over planning"),
    ("Concise", "Concise", "terse: the result first, no preamble or narration"),
    ("Explanatory", "Explanatory", "explains its choices and the codebase's patterns"),
    ("Learning", "Learning", "pauses for you to write small pieces of code"),
)
# Yours, for every folder; another login sees it too (accounts.SHARED links it in).
USER_DIR = os.path.join(os.path.expanduser("~"), ".claude", "output-styles")
# What can be a style's name: a frontmatter `name` or a file stem, on one line.
NAME_RE = re.compile(r"[^\x00-\x1f\x7f]{1,64}")
# The chats you drive. None is the Telegram bot's own chat (dispatch and tgtopics make
# those with no origin); "bridge" is a VS Code or terminal session once the bridge has
# continued it (runner._adopt_native). Every other origin (ticket, ticket-merge, helper,
# automation, preview-queue, rivendell:*, device-run, team) gets no style from Mystical.
ATTENDED = frozenset({None, "dashboard", "miniapp", "bot", "vscode", "terminal", "bridge", "browser", "work"})


def attended(session: dict) -> bool:
    """Whether a turn of this session may take a style: a chat you drive."""
    return session.get("origin") in ATTENDED


def clean(value) -> "str | None":
    """A style pick as it is stored: its name, or None for Not set (blank). ValueError
    when it can't be a style's name. Shape only: the module docstring says why."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("a style is a string")
    v = value.strip()
    if v and not NAME_RE.fullmatch(v):
        raise ValueError(f"not a style name: {v[:80]!r}")
    return v or None


def _folders(cwd: "str | None") -> list:
    """The session's folder up to its repo root, nearest first; outside a repo, the
    folder alone."""
    if not cwd:
        return []
    chain, d = [], os.path.abspath(cwd)
    while True:
        chain.append(d)
        if os.path.exists(os.path.join(d, ".git")):
            return chain
        up = os.path.dirname(d)
        if up == d:
            return chain[:1]
        d = up


def _read(path: str) -> "tuple[str, str] | None":
    """(name, description) of one style file: its frontmatter's, named for the file
    without one. None when it can't be read or its name can't be a style's."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            meta = skills._front_matter(f.read(8192))  # noqa: SLF001
    except OSError:
        return None
    name = meta.get("name") or os.path.splitext(os.path.basename(path))[0]
    return (name, meta.get("description", "")) if NAME_RE.fullmatch(name) else None


def available(cwd: "str | None") -> list:
    """Every style a session in `cwd` can pick, as {id, label, description, source}:
    the built-ins, then the custom ones by name, a folder's over yours and the
    nearest folder's over the rest. No cwd (a profile, a flow): yours only."""
    # shortcut: plugin and managed styles aren't listed (none are installed), read them when one is.
    own: dict = {}
    dirs = [(USER_DIR, "user")] + [(os.path.join(f, ".claude", "output-styles"), "folder")
                                   for f in reversed(_folders(cwd))]
    for d, source in dirs:                 # farthest first, so the nearest writes last
        try:
            names = sorted(n for n in os.listdir(d) if n.endswith(".md"))
        except OSError:
            continue
        for n in names:
            got = _read(os.path.join(d, n))
            if got:
                own[got[0]] = {"id": got[0], "label": got[0], "description": got[1], "source": source}
    built = [{"id": i, "label": label, "description": hint, "source": "built-in"}
             for i, label, hint in BUILT_IN if i not in own]
    return built + sorted(own.values(), key=lambda s: s["id"].lower())
