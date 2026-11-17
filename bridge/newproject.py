"""NEW PROJECT: where a project comes from, decided before anything is touched.

It used to take a name and make BASE_PATH/<name>, whatever you meant. Told "go
work in ~/.config/foo", the agent went there and an empty repo named after the
prompt was left behind in your projects folder. There are four things a person
means by "new project", and each is a kind here:

  new     a fresh repo, BASE_PATH/<name>. What it always did.
  folder  a folder you name. If it doesn't exist it is made; if it exists it is
          used as it is.
  clone   a git URL, cloned into a folder you name or into BASE_PATH.
  chat    no code at all: a folder under BASE_PATH/.mystical-chats, no repo.
          "General chat" is made when the bridge starts, so there is always
          somewhere to talk.

Two things need your yes first, and `prepare` returns them as `confirm` notices
instead of acting until the request says `confirmed`:

  - A folder that isn't a git repository gets `git init` and an empty first
    commit. Empty on purpose: committing whatever is in an arbitrary folder is
    how secrets and build output get into history. Your files stay untracked.
  - A folder outside BASE_PATH is added to the allow-list (bridge/roots.py),
    that folder and nothing above it.

A folder inside a repository is not a second project: the session runs in the
folder and files under the repository's project, like a worktree does. Unless
the repository is one roots refuses (dotfiles kept in a repo at ~), in which
case the folder is the project.

What this doesn't do: several repos in one project. A session has one working
directory, and a parent folder of repos has no git tab. Clone one, then another.

The chat folder is `.mystical-chats` and not `.mystical`: that name already means
a project's runtime folder, with a layout (bridge/mystical_dir.py), and BASE_PATH
is not a project.

`prepare` and the helpers under it create folders and run git; the session and
its first turn are the caller's (the dashboard route), so this imports neither
the store nor the runner. Stdlib only.
"""

import os
import re
import shutil
import subprocess

from bridge import browser, config, git, project_config, roots

GENERAL = "General chat"
CLONE_TIMEOUT = 900
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")
# What `git clone` is handed. No leading dash (an option), no ext:: or fd::
# transport (a command), no local path (that is what `folder` is for).
_URL_RE = re.compile(
    r"^(?:(?:https?|ssh|git)://[^\s]+|[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[^\s]+)$"
)
_SHORT_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class Refused(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


def _slug(s: str) -> str:
    return _SLUG_RE.sub("-", (s or "").strip().strip("/")).strip("-.")


def _resolve(path: str) -> str:
    """A path as typed: ~ and absolute as they are, anything else under BASE_PATH."""
    p = os.path.expanduser((path or "").strip())
    if not p or "\0" in p:
        raise Refused("give a folder")
    if p.startswith("~"):
        raise Refused(f"no such user folder: {p}")
    return os.path.realpath(
        p if os.path.isabs(p) else os.path.join(config.BASE_PATH, p)
    )


def chats_root() -> str:
    return os.path.join(config.BASE_PATH, browser.CHATS_DIR)


def _outside_note(dest: str) -> dict:
    return {
        "kind": "outside",
        "text": f"{dest} is outside your projects folder ({config.BASE_PATH}). "
        "Mystical will be allowed to read, edit and run commands in this folder, "
        "and nowhere above it.",
    }


def _check_outside(dest: str) -> "dict | None":
    """The notice a folder outside BASE_PATH needs, None inside it; Refused where no
    notice would make it right."""
    if browser.within_base(dest):
        return None
    why = roots.refusal(dest)
    if why:
        raise Refused(why, 403)
    return _outside_note(dest)


def _init(dest: str) -> "str | None":
    """git init and an empty first commit. Returns what went wrong, if anything did:
    a repo with no commit still works, so this never stops the project."""
    rc, _, err = git._run(dest, "init")
    if rc:
        return f"git init failed: {err.strip() or rc}"
    rc, _, err = git._run(dest, "commit", "--allow-empty", "-m", "init")
    if rc:
        return (
            "git init ran, but the empty first commit didn't: "
            + (err.strip().splitlines() or [str(rc)])[-1]
        )
    return None


def _toplevel(dest: str) -> str:
    rc, out, _ = git._run(dest, "rev-parse", "--show-toplevel")
    return os.path.realpath(out.strip()) if rc == 0 and out.strip() else dest


def _done(project_dir: str, cwd: str, notes: "list[str]", name: str = "") -> dict:
    rel = browser.rel(project_dir)
    if name and not project_config.get(rel).get("name"):
        project_config.set_name(rel, name)
    return {
        "rel": rel,
        "cwd": cwd,
        "notes": [n for n in notes if n],
        "name": project_config.name(rel, os.path.basename(project_dir)),
    }


def _new(body: dict) -> dict:
    name = _slug(str(body.get("name") or "").lower())
    if not name:
        raise Refused("invalid name")
    dest = os.path.realpath(os.path.join(config.BASE_PATH, name))
    if not browser.within_base(dest) or dest == config.BASE_PATH:
        raise Refused("invalid name")
    if os.path.exists(dest):
        raise Refused("already exists", 409)
    try:
        os.makedirs(dest)
    except OSError as e:
        raise Refused(str(e), 500)
    return _done(dest, dest, [_init(dest)])


def _folder(body: dict) -> dict:
    dest = _resolve(str(body.get("path") or ""))
    if dest == config.BASE_PATH:
        raise Refused("that is your projects folder itself: name a folder inside it")
    if os.path.exists(dest) and not os.path.isdir(dest):
        raise Refused(f"not a folder: {dest}")
    exists = os.path.isdir(dest)
    repo = exists and git.is_repo(dest)
    # The project is the repository the folder is in, when it is in one we may use.
    project_dir = dest
    if repo:
        top = git.main_checkout(_toplevel(dest))
        if browser.within_base(top) or not roots.refusal(top):
            project_dir = top
    if project_dir == config.BASE_PATH:
        project_dir = dest
    confirm = [n for n in (_check_outside(project_dir),) if n]
    if exists and not repo:
        confirm.append(
            {
                "kind": "init",
                "text": f"{dest} is not a git repository. Mystical will run `git init` there "
                "and make an empty first commit. Your files are left as they are, "
                "untracked until you commit them.",
            }
        )
    if confirm and not body.get("confirmed"):
        return {"confirm": confirm, "path": dest}
    notes: "list[str]" = []
    if not exists:
        try:
            os.makedirs(dest)
        except OSError as e:
            raise Refused(str(e), 500)
    if not browser.within_base(project_dir):
        ok, why = roots.add(project_dir)
        if not ok:
            raise Refused(why, 403)
    if not repo:
        notes.append(_init(dest))
    return _done(project_dir, dest, notes)


def clone_url(raw: str) -> str:
    """The URL git is given: owner/repo means GitHub, anything else must look like a remote."""
    url = (raw or "").strip()
    if _SHORT_RE.match(url) and not url.startswith((".", "-")):
        return f"https://github.com/{url.removesuffix('.git')}.git"
    if not _URL_RE.match(url) or url.startswith("-"):
        raise Refused(
            "that doesn't look like a git URL (https://…, git@host:owner/repo, or owner/repo for GitHub)"
        )
    return url


def _clone(body: dict) -> dict:
    url = clone_url(str(body.get("url") or ""))
    name = _slug(str(body.get("name") or "")) or _slug(
        re.split(r"[/:]", url.rstrip("/").removesuffix(".git"))[-1]
    )
    if not name:
        raise Refused("name the folder to clone into")
    parent = (
        _resolve(str(body.get("path") or ""))
        if str(body.get("path") or "").strip()
        else config.BASE_PATH
    )
    if os.path.exists(parent) and not os.path.isdir(parent):
        raise Refused(f"not a folder: {parent}")
    dest = os.path.join(parent, name)
    if os.path.lexists(dest) and (not os.path.isdir(dest) or os.listdir(dest)):
        raise Refused(f"already exists: {dest}", 409)
    confirm = [n for n in (_check_outside(dest),) if n]
    if confirm and not body.get("confirmed"):
        return {"confirm": confirm, "path": dest}
    made = not os.path.lexists(dest)
    try:
        os.makedirs(parent, exist_ok=True)
    except OSError as e:
        raise Refused(str(e), 500)
    # Nothing here can answer a password prompt, so git and ssh are told not to
    # ask: a private repo with no credential fails with git's own words instead
    # of holding the request until the timeout.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    env.setdefault("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
    try:
        p = subprocess.run(
            ["git", "clone", "--", url, dest],
            capture_output=True,
            text=True,
            timeout=CLONE_TIMEOUT,
            env=env,
            stdin=subprocess.DEVNULL,
        )
        rc, err = p.returncode, p.stderr
    except subprocess.TimeoutExpired:
        rc, err = (
            124,
            f"git clone took longer than {CLONE_TIMEOUT // 60} minutes and was stopped",
        )
    except OSError as e:
        rc, err = 127, str(e)
    if rc:
        # git removes what it made when it fails; a clone we stopped leaves it. Only
        # ever a folder this call created.
        if made and os.path.isdir(dest):
            shutil.rmtree(dest, ignore_errors=True)
        lines = [ln for ln in (err or "").strip().splitlines() if ln.strip()]
        raise Refused("git clone failed: " + (" ".join(lines[-3:]) or str(rc)), 502)
    if not browser.within_base(dest):
        ok, why = roots.add(dest)
        if not ok:
            raise Refused(why, 403)
    return _done(dest, dest, [])


def _chat(body: dict) -> dict:
    name = " ".join(str(body.get("name") or "").split())[:60] or GENERAL
    slug = _slug(name.lower())
    if not slug:
        raise Refused("invalid name")
    dest = os.path.join(chats_root(), slug)
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as e:
        raise Refused(str(e), 500)
    return _done(dest, dest, [], name=name)


_KINDS = {"new": _new, "folder": _folder, "clone": _clone, "chat": _chat}


def prepare(body: dict) -> dict:
    """Make the project's folder ready, or say what needs a yes first.

    Returns {"confirm": [{kind, text}], "path"} when nothing was done, else
    {"rel", "name", "cwd", "notes"}: the project's key, its name on screen, where
    its first session runs, and anything that went less than well. Raises Refused."""
    kind = str(body.get("kind") or "new")
    if kind not in _KINDS:
        raise Refused("unknown kind of project")
    return _KINDS[kind](body)


def ensure_general() -> None:
    """General chat exists from the first start. Best-effort: a read-only
    BASE_PATH costs you the shortcut, not the bridge."""
    try:
        _chat({"name": GENERAL})
    except Exception:
        pass
