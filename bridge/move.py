"""Moving a bridge to another machine: `mystical export` on the old one writes a
single file, `mystical import <file>` on the new one replays it.

Everything a bridge has lives on its own disk and nowhere else: the repos cloned
under BASE_PATH (and the work in them that no remote has seen), the MCP servers
and plugins Claude Code was given, ~/.claude's settings and skills, the chat
history Claude Code keeps under ~/.claude/projects, and the bridge's own .env and
state files. GitHub has the pushed commits, not which repos you had or what was
uncommitted. Rivendell keeps nothing about a bridge's machine: its gateway knows
a bridge only as a live socket keyed by the token's owner. So the move is a file.

Replayed rather than copied, because almost none of it is machine-neutral:

- Repos are cloned again from their remotes. Only what no remote has goes in the
  file: a git bundle of the local branches, tags and stashes, a `git diff` patch
  of uncommitted changes, the untracked files, and the git-ignored files that are
  config rather than build output (.env*, .mystical/, .claude/settings.local.json).
  Export never writes to a repo. The bundle is built in a throwaway repo that
  borrows the original's objects through alternates, and every git read passes
  --no-optional-locks, so a session working in that repo right now never runs
  into a lock of ours.
- MCP servers and plugins go back through `claude mcp add-json` and `claude
  plugin`, the same rule bridge/mcp.py and bridge/plugins.py follow: claude owns
  that state, so nothing here edits ~/.claude.json.
- History is rewritten, not copied. Claude Code files a transcript under its cwd,
  encoded into the folder name, and native.scan only lists cwds under BASE_PATH.
  So the old home and BASE_PATH are swapped for this machine's in every line and
  folder name, and each file keeps its mtime so History orders it as before.
- Settings merge and never overwrite. Whatever this machine already has wins, and
  a conflict is reported by key name only, because the values are secrets.

What never moves: logins (Claude, gh, MCP OAuth tokens; each machine has its own
keychain), the Telegram bot token and chat allow-list (two bridges polling one
bot fight over getUpdates), and a live Rivendell link. Rivendell instances arrive
switched OFF. Rivendell sends a job to every bridge its owner has online and lets
the same owner claim it again, so two linked bridges would both run it.

Anything import can't apply is parked under <state>/moved/<host>/ and never
dropped: a repo that won't clone, a patch that won't apply, the bridge DB.

Stdlib only, like the rest of the backend. Run through `bin/mystical`, which
loads .env first, because bridge.config reads BASE_PATH and BRIDGE_DB from the
environment when it is imported.
"""

import argparse
import getpass
import io
import json
import os
import re
import shlex
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from bridge import config

FORMAT = 1
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILE_MAX = 5 * 1024 * 1024          # one untracked or ignored file
REPO_FILES_MAX = 50 * 1024 * 1024   # all of one repo's loose files, worktrees included
UNTRACKED_MAX = 2000                # untracked files carried per checkout
_DEPTH = 4                          # how far below BASE_PATH a repo is looked for
_SKIP_DIRS = {"node_modules", "__pycache__", "venv", "dist", "build", "target", "vendor"}
_CLONE_WORKERS = 4

# ~/.claude folders carried entry by entry. An entry already here is kept.
_CLAUDE_DIRS = ("skills", "agents", "commands", "output-styles", "plans", "hooks", "rules")
# skills/synced and plugins/synced come with the claude.ai login, not the machine.
_SYNCED = "synced"

# The bridge state beside the DB that is configuration. The rest are caches or
# runtime parking lots (cards, nextup, limit_resume, preview_queue, learn-cards).
_STATE_FILES = ("env_settings.json", "ai_features.json", "fallback_policy.json",
                "project_config.json", "trackers.json", "rivendell_instances.json")

# .env and env_settings.json keys that describe the machine itself, or would make
# two bridges fight over one bot. Never carried, whatever the old machine had.
# The tunnel keys need a credentials file that stays behind with them.
_ENV_LOCAL = frozenset({
    "BASE_PATH", "BRIDGE_DB", "BRIDGE_STATE_DIR", "MYSTICAL_LOG", "ACCOUNTS_DIR",
    "FREEAGENTS_FILE", "TELEGRAM_BOT_TOKEN", "ALLOWED_CHAT_IDS", "DASH_TOKEN",
    "CLAUDE_BIN", "CLOUDFLARED_BIN", "TUNNEL_NAME", "TUNNEL_ID",
    "TUNNEL_CREDENTIALS_FILE", "TUNNEL_CONFIG_FILE", "PREVIEW_HOSTNAME",
    "RIVENDELL_ENABLE",
})

# Git-ignored files that are config, not build output: carried, because a clone
# can't bring them back. Example files are tracked or harmless, so they stay.
_CONFIG_NAMES = {".envrc", ".dev.vars", "CLAUDE.local.md", ".mcp.json"}
_NOT_SECRET = (".example", ".sample", ".template", ".dist", ".defaults")

_GH_SSH = re.compile(r"^(?:git@github\.com:|ssh://git@github\.com/)([^/\s]+/[^/\s]+?)(?:\.git)?/?$")
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


# ---------------------------------------------------------------------------
# Machines and paths
# ---------------------------------------------------------------------------

class Machine:
    """Where one machine keeps each thing. Every path export and import touch
    comes from here, so a test can stand two machines side by side in a tmp dir."""

    def __init__(self, home=None, base=None, db=None, env_file=None, mystical=None):
        self.home = os.path.realpath(home or os.path.expanduser("~"))
        self.base = os.path.realpath(base or config.BASE_PATH)
        # The spelling .env used, when it differs from the resolved one: a
        # transcript records whichever the process was started in.
        raw = os.path.abspath(os.path.expanduser(os.environ.get("BASE_PATH", ""))) \
            if base is None and os.environ.get("BASE_PATH") else self.base
        self.bases = sorted({self.base, raw})
        self.db = db or config.BRIDGE_DB
        self.state = os.path.dirname(self.db)
        self.env_file = env_file or os.path.join(REPO_ROOT, ".env")
        self.mystical = mystical or os.path.join(self.home, ".mystical")
        self.freeagents = (os.path.join(mystical, "freeagents.json") if mystical else
                           os.path.expanduser(os.environ.get(
                               "FREEAGENTS_FILE", "~/.mystical/freeagents.json")))
        self.weather = os.path.join(self.mystical, "weather.json")
        self.claude = os.path.join(self.home, ".claude")
        self.claude_json = os.path.join(self.home, ".claude.json")
        self.projects = os.path.join(self.claude, "projects")


def _enc(path: str) -> str:
    """Claude Code's folder name for a cwd under ~/.claude/projects."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


class Remap:
    """Old-machine paths to this machine's. Longest prefix first, matched only on
    a path boundary, so /home/u never rewrites /home/u2 or /home/u.bak."""

    def __init__(self, pairs):
        self.map = {}
        for old, new in pairs:
            old, new = (old or "").rstrip("/"), (new or "").rstrip("/")
            if len(old) > 1 and new and old != new:
                self.map.setdefault(old, new)
        olds = sorted(self.map, key=len, reverse=True)
        # A dot ends a path only when no name follows it: "in /home/u." is the
        # path, "/home/u.bak" is another folder.
        self._re = (re.compile("(" + "|".join(map(re.escape, olds)) + r")(?![\w-])(?!\.[\w-])")
                    if olds else None)
        encs = {}
        for old, new in self.map.items():
            encs.setdefault(_enc(old), _enc(new))
        self._enc = sorted(encs.items(), key=lambda kv: len(kv[0]), reverse=True)

    def text(self, s):
        if not self._re or not isinstance(s, str) or not s:
            return s
        return self._re.sub(lambda m: self.map[m.group(1)], s)

    def obj(self, o):
        """Every string value in a JSON-shaped object. Keys are left alone."""
        if isinstance(o, dict):
            return {k: self.obj(v) for k, v in o.items()}
        if isinstance(o, list):
            return [self.obj(v) for v in o]
        return self.text(o)

    def folder(self, name: str) -> str:
        """A ~/.claude/projects folder name, by its encoded prefix."""
        for old, new in self._enc:
            if name == old or name.startswith(old + "-"):
                return new + name[len(old):]
        return name


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

def _run(argv, cwd=None, timeout=600, stdout=None) -> "tuple[int, str, str]":
    """(rc, stdout, stderr), never raising. GIT_TERMINAL_PROMPT=0 makes a remote
    that wants a password fail instead of waiting on a terminal nobody watches."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        p = subprocess.run(argv, cwd=cwd, env=env, timeout=timeout,
                           stdin=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           stdout=subprocess.PIPE if stdout is None else stdout)
    except FileNotFoundError:
        return 127, "", f"{argv[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{' '.join(argv[:3])}: timed out"
    except OSError as e:
        return 1, "", str(e)
    out = p.stdout.decode("utf-8", "replace") if isinstance(p.stdout, bytes) else ""
    return p.returncode, out, p.stderr.decode("utf-8", "replace").strip()


def _git(repo, *args, timeout=600, stdout=None):
    return _run(["git", "-C", repo, "--no-optional-locks", "-c", "core.quotepath=off",
                 *args], timeout=timeout, stdout=stdout)


def _claude_path() -> str:
    """The `claude` launcher, resolved the way runner.claude_bin() does. Not
    imported from there: export runs on the old machine, and this module should
    need nothing from the bridge but its config."""
    name = config.CLAUDE_BIN
    if os.sep in name:
        return os.path.expanduser(name)
    found = shutil.which(name)
    if found:
        return found
    for cand in ("~/.local/bin/claude", "~/.claude/local/claude"):
        cand = os.path.expanduser(cand)
        if os.access(cand, os.X_OK):
            return cand
    return name


def _claude(args, cwd=None) -> "tuple[int, str, str]":
    """Every `claude` CLI call goes through here, so tests can swap it out and
    the suite never touches the real ~/.claude.json."""
    return _run([_claude_path(), *args], cwd=cwd, timeout=180)


def _claude_json(args, cwd=None):
    rc, out, _ = _claude(args, cwd=cwd)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def _github_ssh_ok() -> bool:
    """Does GitHub accept this machine's SSH key? accept-new records GitHub's host
    key on first contact; BatchMode stops a passphrase prompt from hanging."""
    _, out, err = _run(["ssh", "-T", "-o", "BatchMode=yes", "-o",
                        "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15",
                        "git@github.com"], timeout=40)
    return "successfully authenticated" in (out + err)


# ---------------------------------------------------------------------------
# Small file helpers
# ---------------------------------------------------------------------------

def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_private(path, data: bytes) -> None:
    """Atomic, mode 0600: most of what import writes holds a secret."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".mystical-import"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _write_json(path, obj) -> None:
    _write_private(path, (json.dumps(obj, indent=1) + "\n").encode())


def _backup(path, stamp) -> None:
    if os.path.isfile(path):
        shutil.copy2(path, f"{path}.bak-{stamp}")


def _slug(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (s or "").lower())).strip("-") or "old"


def _norm_url(url: str) -> str:
    """One spelling per remote, so git@github.com:o/r.git matches https://github.com/o/r."""
    u = (url or "").strip().lower()
    u = re.sub(r"^[a-z][a-z0-9+.-]*://", "", u)
    u = re.sub(r"^[^@/]+@", "", u)
    u = re.sub(r"^([^/:]+):(?!\d)", r"\1/", u)
    return re.sub(r"\.git$", "", u.rstrip("/"))


def _is_config(rel: str) -> bool:
    b = os.path.basename(rel)
    if b in _CONFIG_NAMES or rel == ".claude/settings.local.json" \
            or rel.endswith("/.claude/settings.local.json"):
        return True
    if b == ".env" or b.startswith(".env.") or b.endswith(".env"):
        return not b.endswith(_NOT_SECRET)
    return False


def _home(path: str, home: str) -> str:
    """~ and $HOME at the front of a path, read as `home` (not this process's)."""
    return re.sub(r"^(?:~|\$HOME|\$\{HOME\})(?=/|$)", lambda _: home, path or "")


def _last(text: str) -> str:
    lines = (text or "").strip().splitlines()
    return lines[-1][:200] if lines else ""


def _size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

class _Pack:
    """Writes into the tar. Symlinks are followed, so every member is a regular
    file and import's extraction filter never meets a link pointing outside."""

    _INLINE = 32 * 1024 * 1024

    def __init__(self, tar, tmp):
        self.tar, self.tmp, self.bytes = tar, tmp, 0

    def file(self, src, arc) -> int:
        """Bytes added, 0 when src isn't a readable regular file."""
        try:
            st = os.stat(src)
            if not stat.S_ISREG(st.st_mode):
                return 0
            ti = tarfile.TarInfo(arc)
            ti.mtime, ti.mode = st.st_mtime, st.st_mode & 0o777
            # Read small files whole: a transcript a live session appends to
            # mid-read must not leave the member shorter than its header says.
            if st.st_size <= self._INLINE:
                with open(src, "rb") as f:
                    data = f.read()
                ti.size = len(data)
                self.tar.addfile(ti, io.BytesIO(data))
            else:
                ti.size = st.st_size
                with open(src, "rb") as f:
                    self.tar.addfile(ti, f)
        except OSError:
            return 0
        self.bytes += ti.size
        return ti.size

    def tree(self, src, arc, skip=None) -> "tuple[int, int]":
        """(files, bytes) under src. `skip(rel)` drops a file or folder."""
        files = size = 0
        seen = set()
        for root, dirs, names in os.walk(src, followlinks=True):
            try:
                st = os.stat(root)
            except OSError:
                dirs[:] = []
                continue
            if (st.st_dev, st.st_ino) in seen:       # a symlink loop
                dirs[:] = []
                continue
            seen.add((st.st_dev, st.st_ino))
            rel_root = os.path.relpath(root, src)
            rel_root = "" if rel_root == "." else rel_root + "/"
            dirs[:] = sorted(d for d in dirs if not (skip and skip(rel_root + d + "/")))
            for n in sorted(names):
                rel = rel_root + n
                if skip and skip(rel):
                    continue
                got = self.file(os.path.join(root, n), f"{arc}/{rel}")
                if got or os.path.isfile(os.path.join(root, n)):
                    files += 1
                    size += got
        return files, size

    def data(self, arc, data: bytes) -> None:
        ti = tarfile.TarInfo(arc)
        ti.size, ti.mtime, ti.mode = len(data), time.time(), 0o600
        self.tar.addfile(ti, io.BytesIO(data))


def _find_repos(base) -> "list[str]":
    """Repos under base, as paths relative to it ("." when base is one). A linked
    worktree is skipped here: its main repo carries it."""
    out = []
    for root, dirs, files in os.walk(base):
        rel = os.path.relpath(root, base)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if ".git" in dirs or ".git" in files:
            linked = False
            if ".git" in files:
                try:
                    with open(os.path.join(root, ".git"), encoding="utf-8") as f:
                        linked = "/worktrees/" in f.read()
                except OSError:
                    linked = True
            if not linked:
                out.append(rel)
            if root != base:
                dirs[:] = []
                continue
        if depth >= _DEPTH:
            dirs[:] = []
            continue
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in _SKIP_DIRS)
    return sorted(out)


def _remotes(repo) -> "dict[str, str]":
    rc, out, _ = _git(repo, "config", "--get-regexp", r"^remote\..*\.url$")
    got = {}
    for line in out.splitlines() if rc == 0 else []:
        key, _, url = line.partition(" ")
        name = key[len("remote."):-len(".url")]
        if name and url:
            got.setdefault(name, url.strip())
    return got


def _refs(repo, pattern) -> "list[tuple[str, str, str]]":
    rc, out, _ = _git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream)",
                      pattern)
    rows = []
    for line in out.splitlines() if rc == 0 else []:
        parts = line.split("\t")
        if len(parts) == 3 and parts[1]:
            rows.append((parts[0], parts[1], parts[2]))
    return rows


def _worktrees(repo) -> "list[dict]":
    """The repo's linked worktrees (never the main one)."""
    rc, out, _ = _git(repo, "worktree", "list", "--porcelain")
    if rc != 0:
        return []
    found = []
    for block in out.strip().split("\n\n")[1:]:
        d = {}
        for line in block.splitlines():
            k, _, v = line.partition(" ")
            d[k] = v
        if "bare" in d or not d.get("worktree"):
            continue
        br = d.get("branch", "")
        found.append({"path": d["worktree"], "sha": d.get("HEAD") or None,
                      "branch": br[len("refs/heads/"):] if br.startswith("refs/heads/") else None})
    return found


def _bundle(repo, want: "dict[str, str]", remote_tips: "list[tuple[str, str]]", out):
    """Write a bundle of `want` (ref -> sha) minus everything the remote-tracking
    refs reach, without writing a ref into the repo: the refs are made in a
    throwaway bare repo that borrows repo's objects. (ok, unpushed commits, error)."""
    if not want:
        return False, 0, ""
    rc, objs, err = _git(repo, "rev-parse", "--git-path", "objects")
    if rc != 0:
        return False, 0, err
    objs = objs.strip()
    if not os.path.isabs(objs):
        objs = os.path.join(repo, objs)
    with tempfile.TemporaryDirectory(prefix="mystical-bundle-") as tb:
        rc, _, err = _run(["git", "init", "-q", "--bare", tb])
        if rc != 0:
            return False, 0, err
        with open(os.path.join(tb, "objects", "info", "alternates"), "w") as f:
            f.write(os.path.realpath(objs) + "\n")
        lines = "".join(f"update {r} {s}\n" for r, s in list(want.items()) + remote_tips)
        p = subprocess.run(["git", "-C", tb, "update-ref", "--stdin"], input=lines.encode(),
                           capture_output=True)
        if p.returncode != 0:
            return False, 0, p.stderr.decode("utf-8", "replace").strip()
        sel = ["--branches", "--tags", "--glob=refs/mystical/*", "--not", "--remotes"]
        _, n, _ = _run(["git", "-C", tb, "rev-list", "--count", *sel])
        rc, _, err = _run(["git", "-C", tb, "bundle", "create", out, *sel], timeout=1800)
        if rc != 0:
            # Nothing the remotes lack is the common case, not a failure.
            return False, 0, "" if "empty bundle" in err else err.splitlines()[-1] if err else "failed"
        return True, int(n.strip() or 0), ""


def _export_checkout(path, arc, pack, budget, head) -> dict:
    """One checkout's uncommitted state: a patch of tracked changes, plus the
    untracked files and the ignored config files, as plain files."""
    out = {"arc": arc, "patch": None, "files": [], "skipped": []}
    rc, st, err = _git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if rc != 0:
        out["skipped"].append({"path": ".", "why": f"git status failed: {err[:200]}"})
        return out
    dirty, untracked = False, []
    toks = st.split("\0")
    i = 0
    while i < len(toks):
        t = toks[i]
        i += 1
        if len(t) < 4:
            continue
        code, p = t[:2], t[3:]
        if code[0] in "RC":
            i += 1                                   # the rename's source path
        if code == "??":
            untracked.append(p)
        elif code != "!!":
            dirty = True
    if dirty and head:
        patch = os.path.join(pack.tmp, arc.replace("/", "_") + ".patch")
        with open(patch, "wb") as f:
            # A moved submodule pointer would stop the whole patch applying.
            rc, _, err = _git(path, "diff", "--binary", "--ignore-submodules", "HEAD", stdout=f)
        if rc == 0 and os.path.getsize(patch):
            pack.file(patch, f"{arc}/uncommitted.patch")
            out["patch"] = f"{arc}/uncommitted.patch"
        elif rc != 0:
            out["skipped"].append({"path": ".", "why": f"git diff failed: {err[:200]}"})
        os.remove(patch)

    carried = []
    rc, ig, _ = _git(path, "ls-files", "-z", "--others", "--ignored", "--exclude-standard",
                     "--directory")
    for p in ig.split("\0") if rc == 0 else []:
        if p and not p.endswith("/") and _is_config(p) and not p.startswith(".mystical/"):
            carried.append(p)
        elif p.endswith(".claude/") and os.path.isfile(os.path.join(path, p, "settings.local.json")):
            carried.append(p + "settings.local.json")
    mystical = os.path.join(path, ".mystical")
    if os.path.isdir(mystical):
        for root, dirs, names in os.walk(mystical):
            dirs[:] = sorted(dirs)
            for n in sorted(names):
                if not n.endswith(".log"):
                    carried.append(os.path.relpath(os.path.join(root, n), path))

    files = untracked[:UNTRACKED_MAX] + [p for p in dict.fromkeys(carried) if p not in untracked]
    if len(untracked) > UNTRACKED_MAX:
        out["skipped"].append({"path": f"{len(untracked) - UNTRACKED_MAX} more untracked files",
                               "why": f"over {UNTRACKED_MAX} per checkout"})
    for p in files:
        full = os.path.join(path, p)
        try:
            size = os.stat(full).st_size
        except OSError:
            continue
        if not os.path.isfile(full):
            continue
        if size > FILE_MAX:
            out["skipped"].append({"path": p, "size": size, "why": f"over {_size(FILE_MAX)}"})
            continue
        if budget[0] + size > REPO_FILES_MAX:
            out["skipped"].append({"path": p, "size": size,
                                   "why": f"repo past {_size(REPO_FILES_MAX)} of loose files"})
            continue
        if pack.file(full, f"{arc}/files/{p}") or size == 0:
            out["files"].append(p)
            budget[0] += size
    return out


def _export_repo(m, rel, arc, pack) -> dict:
    path = m.base if rel == "." else os.path.join(m.base, rel)
    r = {"path": rel, "remotes": _remotes(path), "warnings": []}
    rc, sha, _ = _git(path, "rev-parse", "-q", "--verify", "HEAD^{commit}")
    sha = sha.strip() if rc == 0 else None
    rc, br, _ = _git(path, "symbolic-ref", "-q", "HEAD")
    br = br.strip()
    r["head"] = {"branch": br[len("refs/heads/"):] if rc == 0 and br.startswith("refs/heads/")
                 else None, "sha": sha}
    r["branches"] = [{"name": ref[len("refs/heads/"):], "sha": s, "upstream": up}
                     for ref, s, up in _refs(path, "refs/heads")]
    r["tags"] = {ref[len("refs/tags/"):]: s for ref, s, _ in _refs(path, "refs/tags")}
    rc, out, _ = _git(path, "stash", "list", "--format=%H%x09%gs")
    r["stashes"] = [{"sha": s, "message": msg} for s, _, msg in
                    (line.partition("\t") for line in out.splitlines()) if s] if rc == 0 else []
    r["submodules"] = os.path.isfile(os.path.join(path, ".gitmodules"))
    wts = _worktrees(path)

    want = {f"refs/heads/{b['name']}": b["sha"] for b in r["branches"]}
    want.update({f"refs/tags/{t}": s for t, s in r["tags"].items()})
    want.update({f"refs/mystical/stash/{i}": s["sha"] for i, s in enumerate(r["stashes"])})
    if sha and not r["head"]["branch"]:
        want["refs/mystical/HEAD"] = sha
    for i, w in enumerate(wts):
        if w["sha"] and not w["branch"]:
            want[f"refs/mystical/wt/{i}"] = w["sha"]
    tips = [(ref, s) for ref, s, _ in _refs(path, "refs/remotes")]
    out_bundle = os.path.join(pack.tmp, arc.replace("/", "_") + ".bundle")
    ok, r["unpushed"], err = _bundle(path, want, tips, out_bundle)
    r["bundle"] = None
    if ok:
        pack.file(out_bundle, f"{arc}/unpushed.bundle")
        r["bundle"] = f"{arc}/unpushed.bundle"
        os.remove(out_bundle)
    elif err:
        r["warnings"].append(f"commits no remote has were NOT carried: {err[:200]}")

    budget = [0]
    r["main"] = _export_checkout(path, f"{arc}/main", pack, budget, sha)
    r["worktrees"] = []
    for i, w in enumerate(wts):
        if not os.path.isdir(w["path"]):
            continue                                   # prunable: its folder is gone
        wrel = os.path.relpath(w["path"], m.base)
        if wrel.startswith(".."):
            r["warnings"].append(f"worktree outside BASE_PATH not carried: {w['path']}")
            continue
        e = {"path": wrel, "branch": w["branch"], "sha": w["sha"]}
        e.update(_export_checkout(w["path"], f"{arc}/wt{i}", pack, budget, w["sha"]))
        r["worktrees"].append(e)
    return r


def _export_plugins(m) -> dict:
    """Marketplaces and plugins, from the CLI's own --json; the files it keeps
    when that CLI is too old to answer."""
    mk = _claude_json(["plugin", "marketplace", "list", "--json"])
    pl = _claude_json(["plugin", "list", "--json"])
    if mk is None:
        known = _read_json(os.path.join(m.claude, "plugins", "known_marketplaces.json")) or {}
        mk = [{"name": n, **((v or {}).get("source") or {})} for n, v in known.items()]
    if pl is None:
        inst = (_read_json(os.path.join(m.claude, "plugins", "installed_plugins.json")) or {})
        pl = []
        for pid, v in (inst.get("plugins") or {}).items():
            for e in v if isinstance(v, list) else [v]:
                pl.append({"id": pid, "scope": (e or {}).get("scope") or "user",
                           "enabled": True, "projectPath": (e or {}).get("projectPath")})
    marketplaces = []
    for x in mk or []:
        src = x.get("repo") or x.get("url") or x.get("path")
        if x.get("name") and src and x.get("name") != _SYNCED:
            marketplaces.append({"name": x["name"], "source": src, "kind": x.get("source")})
    plugins = [{"id": p["id"], "scope": p.get("scope") or "user",
                "enabled": bool(p.get("enabled", True)), "project": p.get("projectPath")}
               for p in pl or []
               if p.get("id") and p.get("scope") != _SYNCED and not p["id"].endswith("@" + _SYNCED)]
    return {"marketplaces": marketplaces, "plugins": plugins}


def _command_paths(settings, home, base) -> "list[str]":
    """Files under home (outside BASE_PATH) that the hooks and status line run."""
    cmds = []
    for entries in ((settings or {}).get("hooks") or {}).values():
        for entry in entries if isinstance(entries, list) else []:
            for h in (entry or {}).get("hooks") or []:
                if isinstance(h, dict) and isinstance(h.get("command"), str):
                    cmds.append(h["command"])
    sl = (settings or {}).get("statusLine")
    if isinstance(sl, dict) and isinstance(sl.get("command"), str):
        cmds.append(sl["command"])
    found = []
    for cmd in cmds:
        for tok in re.findall(r"(?:~|\$HOME|\$\{HOME\})?/[^\s'\";|&<>()]+", cmd):
            p = _home(tok, home)
            if p.startswith(home + "/") and not p.startswith(base + "/") \
                    and os.path.isfile(p) and os.path.getsize(p) < 1024 * 1024:
                found.append(os.path.relpath(p, home))
    return sorted(set(found))


def export(out=None, m=None, history=True, log=print) -> str:
    """Write the move file. Returns its path."""
    m = m or Machine()
    host = socket.gethostname().split(".")[0] or "old"
    out = os.path.abspath(out or os.path.join(
        m.home, f"mystical-move-{_slug(host)}-{time.strftime('%Y%m%d-%H%M')}.tar.gz"))
    _, commit, _ = _git(REPO_ROOT, "rev-parse", "--short", "HEAD")
    _, cv, _ = _claude(["--version"])
    man = {"format": FORMAT, "from": {
        "host": host, "platform": sys.platform, "home": m.home, "base": m.base,
        "bases": m.bases, "user": getpass.getuser(), "at": time.time(),
        "mystical": commit.strip(), "claude": cv.strip()}}
    log(f"exporting from {host}: {m.base}")
    try:
        with tempfile.TemporaryDirectory(prefix="mystical-export-") as tmp:
            fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as fh, \
                    tarfile.open(fileobj=fh, mode="w:gz", compresslevel=6) as tar:
                pack = _Pack(tar, tmp)
                man["repos"], man["loose"] = _export_repos(m, pack, log)
                man["mcp"] = _export_mcp(m)
                man["plugins"] = _export_plugins(m)
                man["claude"] = _export_claude(m, pack)
                man["history"] = _export_history(m, pack) if history else {"skipped": True}
                man["bridge"] = _export_bridge(m, pack, tmp)
                pack.data("manifest.json", json.dumps(man, indent=1).encode())
    except BaseException:
        try:
            os.remove(out)
        except OSError:
            pass
        raise
    os.chmod(out, 0o600)
    _print_export(man, out, log)
    return out


def _export_repos(m, pack, log):
    repos = []
    found = _find_repos(m.base)
    for i, rel in enumerate(found):
        try:
            r = _export_repo(m, rel, f"repos/{i:04d}", pack)
        except Exception as e:                                 # one repo never sinks the rest
            r = {"path": rel, "error": f"{type(e).__name__}: {e}"}
        bits = []
        if r.get("unpushed"):
            bits.append(f"{r['unpushed']} commit(s) no remote has")
        if any(c.get("patch") for c in [r.get("main") or {}, *(r.get("worktrees") or [])]):
            bits.append("uncommitted changes")
        log(f"  {rel}" + (f"  ({', '.join(bits)})" if bits else "") +
            (f"  ✘ {r['error']}" if r.get("error") else ""))
        repos.append(r)
    tops = {rel.split(os.sep)[0] for rel in found}
    loose = []
    if "." not in found:
        for name in sorted(os.listdir(m.base)):
            full = os.path.join(m.base, name)
            if name.startswith(".") or name in tops:
                continue
            loose.append(name + ("/" if os.path.isdir(full) else ""))
    return repos, loose


def _export_mcp(m) -> dict:
    cj = _read_json(m.claude_json) or {}
    local = {p: v["mcpServers"] for p, v in (cj.get("projects") or {}).items()
             if isinstance(v, dict) and isinstance(v.get("mcpServers"), dict) and v["mcpServers"]}
    return {"user": cj.get("mcpServers") or {}, "local": local}


def _export_claude(m, pack) -> dict:
    c = {"dirs": {}, "home_files": []}
    settings = _read_json(os.path.join(m.claude, "settings.json"))
    if isinstance(settings, dict):
        c["settings"] = settings
    for name in ("CLAUDE.md", "keybindings.json"):
        if pack.file(os.path.join(m.claude, name), f"claude/{name}") or \
                os.path.isfile(os.path.join(m.claude, name)):
            c.setdefault("files", []).append(name)
    for d in _CLAUDE_DIRS:
        src = os.path.join(m.claude, d)
        if os.path.isdir(src):
            n, _ = pack.tree(src, f"claude/{d}", skip=lambda rel: rel.split("/")[0] == _SYNCED)
            if n:
                c["dirs"][d] = n
    for rel in _command_paths(settings, m.home, m.base):
        if pack.file(os.path.join(m.home, rel), f"home/{rel}"):
            c["home_files"].append(rel)
    return c


def _export_history(m, pack) -> dict:
    h = {"files": 0, "bytes": 0, "transcripts": 0, "prompts": False}
    if os.path.isdir(m.projects):
        h["files"], h["bytes"] = pack.tree(m.projects, "claude/projects")
        for d in os.listdir(m.projects):
            full = os.path.join(m.projects, d)
            if os.path.isdir(full):
                h["transcripts"] += sum(1 for n in os.listdir(full) if n.endswith(".jsonl"))
    h["prompts"] = bool(pack.file(os.path.join(m.claude, "history.jsonl"), "claude/history.jsonl"))
    return h


def _export_bridge(m, pack, tmp) -> dict:
    b = {"env": bool(pack.file(m.env_file, "bridge/env")), "state": [], "mystical": [],
         "db": False}
    for name in _STATE_FILES:
        if pack.file(os.path.join(m.state, name), f"bridge/state/{name}"):
            b["state"].append(name)
    for name, p in (("freeagents.json", m.freeagents), ("weather.json", m.weather)):
        if pack.file(p, f"bridge/mystical/{name}"):
            b["mystical"].append(name)
    if os.path.isfile(m.db):
        snap = os.path.join(tmp, "bridge.db")
        src, dst = sqlite3.connect(m.db, timeout=30), sqlite3.connect(snap)
        try:
            src.backup(dst)                      # consistent even while the bridge writes
        finally:
            src.close()
            dst.close()
        b["db"] = bool(pack.file(snap, "bridge/bridge.db"))
    return b


def _print_export(man, out, log) -> None:
    repos = man.get("repos") or []
    unpushed = sum(1 for r in repos if r.get("unpushed"))
    dirty = sum(1 for r in repos if any(c.get("patch") for c in
                                        [r.get("main") or {}, *(r.get("worktrees") or [])]))
    mcp = man.get("mcp") or {}
    n_local = sum(len(v) for v in (mcp.get("local") or {}).values())
    pl = man.get("plugins") or {}
    cl = man.get("claude") or {}
    h = man.get("history") or {}
    b = man.get("bridge") or {}
    log("")
    log(f"✔ {out}  ({_size(os.path.getsize(out))})")
    log(f"  repos     {len(repos)}" + (f" — {unpushed} with commits no remote has, "
                                         f"{dirty} with uncommitted changes, all carried"
                                         if unpushed or dirty else ""))
    if man.get("loose"):
        log(f"  not git   {len(man['loose'])} left behind (copy by hand if you need them): "
            + ", ".join(man["loose"][:8]) + (" …" if len(man["loose"]) > 8 else ""))
    log(f"  mcp       {len(mcp.get('user') or {})} user, {n_local} project-local")
    log(f"  plugins   {len(pl.get('plugins') or [])} from "
        f"{len(pl.get('marketplaces') or [])} marketplace(s)")
    log("  claude    " + (", ".join(
        (["settings"] if cl.get("settings") else []) + list(cl.get("files") or []) +
        [f"{d} {n}" for d, n in (cl.get("dirs") or {}).items()]) or "nothing"))
    log("  history   " + ("skipped (--no-history)" if h.get("skipped") else
                          f"{h.get('transcripts', 0)} transcripts, {_size(h.get('bytes', 0))}"))
    log("  bridge    " + (", ".join(([".env"] if b.get("env") else []) + b.get("state", []) +
                                     (["bridge.db"] if b.get("db") else [])) or "nothing"))
    for r in repos:
        for w in r.get("warnings") or []:
            log(f"  ▲ {r['path']}: {w}")
        for c in [r.get("main") or {}, *(r.get("worktrees") or [])]:
            for s in c.get("skipped") or []:
                log(f"  ▲ {r['path']}: {s['path']} left behind — {s['why']}")
        if r.get("error"):
            log(f"  ✘ {r['path']}: {r['error']}")
    log("")
    log("  It holds secrets (.env files, tokens, MCP keys). Move it straight to the new")
    log("  machine, run `mystical import <file>` there, then delete it.")


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def _extract(path, dest) -> None:
    with tarfile.open(path, "r:gz") as tar:
        if hasattr(tarfile, "data_filter"):
            tar.extractall(dest, filter="data")
            return
        for mem in tar.getmembers():                  # Pythons without extraction filters
            name = mem.name
            if name.startswith("/") or ".." in name.split("/") or not (mem.isfile() or mem.isdir()):
                raise ValueError(f"refusing archive member {name!r}")
        tar.extractall(dest)


def import_file(path, m=None, dry=False, log=print) -> dict:
    """Replay a move file onto this machine. Returns the report."""
    m = m or Machine()
    path = os.path.abspath(path)
    with tempfile.TemporaryDirectory(prefix="mystical-import-") as root:
        _extract(path, root)
        man = _read_json(os.path.join(root, "manifest.json"))
        if not isinstance(man, dict) or man.get("format") != FORMAT:
            raise SystemExit(f"{path}: not a mystical export (or from a newer mystical)")
        imp = _Import(root, man, m, dry, log)
        src = man["from"]
        log(f"{'dry run — nothing changes. ' if dry else ''}importing {src.get('host')} "
            f"({src.get('base')}) into {m.base}")
        for step in (imp.repos, imp.claude, imp.mcp, imp.plugins, imp.history, imp.bridge):
            try:
                step()
            except Exception as e:                  # one broken step never sinks the rest
                imp.note(step.__name__, "failed", f"{type(e).__name__}: {e}")
        imp.finish()
        return imp.rep


class _Import:
    def __init__(self, root, man, m, dry, log):
        self.root, self.man, self.m, self.dry, self.log = root, man, m, dry, log
        src = man.get("from") or {}
        self.host = _slug(src.get("host") or "old")
        self.remap = Remap([(b, m.base) for b in src.get("bases") or [src.get("base")]] +
                           [(src.get("home"), m.home)])
        self.park = os.path.join(m.state, "moved", self.host)
        self.stamp = time.strftime("%Y%m%d-%H%M%S")
        self.rep = {}
        self._lock = threading.Lock()
        self._https = False

    def note(self, section, key, item) -> None:
        with self._lock:
            self.rep.setdefault(section, {}).setdefault(key, []).append(item)

    def arc(self, rel):
        return os.path.join(self.root, rel) if rel else None

    # -- repos -------------------------------------------------------------

    def repos(self):
        items = self.man.get("repos") or []
        urls = [u for r in items for u in (r.get("remotes") or {}).values()]
        if not self.dry and any(_GH_SSH.match(u) for u in urls) and not _github_ssh_ok():
            self._https = True
            if not self.dry and shutil.which("gh") and _run(["gh", "auth", "status"])[0] == 0:
                _run(["gh", "auth", "setup-git"])
                self.note("repos", "notes", "GitHub remotes cloned over HTTPS with gh's login "
                          "(`gh auth setup-git` ran): GitHub doesn't accept this machine's SSH "
                          "key yet. `gh ssh-key add ~/.ssh/id_ed25519.pub` fixes that.")
            else:
                self.note("repos", "notes", "GitHub remotes cloned over HTTPS: GitHub doesn't "
                          "accept this machine's SSH key, and gh isn't logged in, so private "
                          "repos will fail until `gh auth login`.")
        with ThreadPoolExecutor(_CLONE_WORKERS) as pool:
            list(pool.map(self._repo_safe, items))

    def _repo_safe(self, r):
        try:
            self._repo(r)
        except Exception as e:
            self.note("repos", "failed", f"{r.get('path')}: {type(e).__name__}: {e}")
            self._park_repo(r)
        if not self.dry:
            with self._lock:
                self.log(f"  {r.get('path')}")

    def _transport(self, url):
        mt = _GH_SSH.match(url or "")
        return f"https://github.com/{mt.group(1)}.git" if self._https and mt else url

    def _repo(self, r):
        rel = r["path"]
        dest = self.m.base if rel == "." else os.path.join(self.m.base, rel)
        if r.get("error"):
            self.note("repos", "failed", f"{rel}: the export couldn't read it ({r['error']})")
            return
        if rel == "." and not os.path.exists(os.path.join(dest, ".git")):
            # The old BASE_PATH was itself a repo. Cloning into this one would put
            # it around every other repo arriving here, so it waits for a hand.
            self.note("repos", "skipped", "BASE_PATH itself was a repo on the old machine")
            self._park_repo(r)
            return
        bundle = self.arc(r.get("bundle"))
        fresh = False
        if os.path.exists(os.path.join(dest, ".git")) or os.path.isfile(dest) or \
                (os.path.isdir(dest) and os.listdir(dest)):
            if not self._same_repo(dest, r):
                self.note("repos", "skipped", f"{rel}: something else is already there")
                self._park_repo(r)
                return
            self.note("repos", "present", rel)
        elif self.dry:
            self.note("repos", "clone", rel + (f" (+{r['unpushed']} commit(s) from the file)"
                                               if r.get("unpushed") else ""))
            return
        else:
            ok, how = self._clone(r, dest, bundle)
            if not ok:
                self.note("repos", "failed", f"{rel}: {how}")
                self._park_repo(r)
                return
            fresh = True
            self.note("repos", "cloned", rel + (f" ({how})" if how else ""))
        if self.dry:
            return

        if bundle:
            rc, _, err = _git(dest, "fetch", "-q", bundle, "+refs/*:refs/mystical-move/*",
                              timeout=1800)
            if rc != 0:
                self.note("repos", "failed", f"{rel}: its commits no remote has didn't load "
                          f"({err.splitlines()[-1] if err else 'fetch failed'})")
                self._park_repo(r)
        self._branches(dest, r, fresh)
        if fresh:
            self._checkout(dest, r)
        self._stashes(dest, r)
        self._checkout_state(dest, r.get("main") or {}, rel, fresh,
                             (r.get("head") or {}).get("sha"))
        for w in r.get("worktrees") or []:
            self._worktree(dest, w)
        rc, out, _ = _git(dest, "for-each-ref", "--format=%(refname)", "refs/mystical-move/")
        if rc == 0 and out.strip():
            subprocess.run(["git", "-C", dest, "update-ref", "--stdin"], capture_output=True,
                           input="".join(f"delete {x}\n" for x in out.split()).encode())

    def _same_repo(self, dest, r) -> bool:
        if not os.path.exists(os.path.join(dest, ".git")):
            return False
        theirs = {_norm_url(u) for u in (r.get("remotes") or {}).values()}
        if theirs:
            return bool(theirs & {_norm_url(u) for u in _remotes(dest).values()})
        sha = (r.get("head") or {}).get("sha")
        return bool(sha) and _git(dest, "cat-file", "-e", f"{sha}^{{commit}}")[0] == 0

    def _clone(self, r, dest, bundle):
        remotes = r.get("remotes") or {}
        name = "origin" if "origin" in remotes else next(iter(remotes), None)
        os.makedirs(os.path.dirname(dest.rstrip("/")) or "/", exist_ok=True)
        # Only ever remove what this clone created: an empty folder that was
        # already here stays, and nothing above it is touched.
        existed = os.path.exists(dest)

        def undo():
            if not existed:
                shutil.rmtree(dest, ignore_errors=True)

        if name:
            url = self._transport(remotes[name])
            rc, _, err = _run(["git", "clone", "-q", "--no-checkout", "-o", name, url, dest],
                              timeout=3600)
            if rc != 0:
                undo()
                return False, (err.splitlines()[-1] if err else "clone failed")
            for n, u in remotes.items():
                if n != name:
                    _git(dest, "remote", "add", n, self._transport(u))
                    if _git(dest, "fetch", "-q", n, timeout=1800)[0] != 0:
                        self.note("repos", "notes", f"{r['path']}: remote {n} didn't fetch")
            return True, "over HTTPS" if url != remotes[name] else ""
        if bundle:
            rc, _, err = _run(["git", "clone", "-q", "--no-checkout", bundle, dest], timeout=1800)
            if rc != 0:
                undo()
                return False, (err.splitlines()[-1] if err else "clone failed")
            _git(dest, "remote", "remove", "origin")
            return True, "from the file, it has no remote"
        return False, "no remote, and no commits in the file to rebuild it from"

    def _has(self, dest, sha) -> bool:
        return bool(sha) and _git(dest, "cat-file", "-e", f"{sha}^{{commit}}")[0] == 0

    def _ref(self, dest, ref):
        rc, out, _ = _git(dest, "rev-parse", "-q", "--verify", ref)
        return out.strip() if rc == 0 else None

    def _branches(self, dest, r, fresh):
        """A fresh clone gets every branch exactly where the old machine had it. A
        repo that was already here keeps its branches; one that differs gets the
        old tip beside it, as moved/<host>/<branch>, so nothing is lost."""
        rel = r["path"]
        restored = 0
        for b in r.get("branches") or []:
            name, sha = b["name"], b["sha"]
            if not self._has(dest, sha):
                self.note("repos", "missing", f"{rel}: branch {name} — its commit is on no "
                          "remote and wasn't in the file")
                continue
            have = self._ref(dest, f"refs/heads/{name}")
            if have == sha:
                continue
            if have is None or fresh:
                _git(dest, "update-ref", f"refs/heads/{name}", sha)
                restored += 1
                up = b.get("upstream") or ""
                if up.startswith("refs/remotes/") and self._ref(dest, up):
                    _git(dest, "branch", f"--set-upstream-to={up[len('refs/remotes/'):]}", name)
            else:
                side = f"moved/{self.host}/{name}"
                if self._ref(dest, f"refs/heads/{side}") is None:
                    _git(dest, "update-ref", f"refs/heads/{side}", sha)
                    self.note("repos", "notes", f"{rel}: {name} differs here — the old "
                              f"machine's is branch {side}")
        for t, sha in (r.get("tags") or {}).items():
            if self._ref(dest, f"refs/tags/{t}") is None and \
                    _git(dest, "cat-file", "-e", sha)[0] == 0:
                _git(dest, "update-ref", f"refs/tags/{t}", sha)
        if restored and r.get("unpushed"):
            self.note("repos", "unpushed", f"{rel}: {r['unpushed']} commit(s) no remote has")

    def _checkout(self, dest, r):
        """Point HEAD where the old machine had it, then fill the working tree.
        Only on a clone made this run (--no-checkout), so reset has nothing to lose."""
        h = r.get("head") or {}
        if h.get("branch") and self._ref(dest, f"refs/heads/{h['branch']}"):
            _git(dest, "symbolic-ref", "HEAD", f"refs/heads/{h['branch']}")
        elif h.get("sha") and self._has(dest, h["sha"]):
            _git(dest, "update-ref", "--no-deref", "HEAD", h["sha"])
        if self._ref(dest, "HEAD"):
            rc, _, err = _git(dest, "reset", "-q", "--hard", timeout=1800)
            if rc != 0:
                self.note("repos", "failed", f"{r['path']}: checkout failed ({err[:200]})")
        if r.get("submodules"):
            rc, _, err = _git(dest, "submodule", "update", "--init", "--recursive", timeout=3600)
            if rc != 0:
                self.note("repos", "notes", f"{r['path']}: submodules didn't load — "
                          "`git submodule update --init --recursive` there")

    def _stashes(self, dest, r):
        rc, out, _ = _git(dest, "stash", "list", "--format=%H")
        have = set(out.split()) if rc == 0 else set()
        n = 0
        for s in reversed(r.get("stashes") or []):      # oldest first: stash@{0} stays newest
            if s["sha"] in have or not self._has(dest, s["sha"]):
                continue
            if _git(dest, "stash", "store", "-m", s.get("message") or "stash", s["sha"])[0] == 0:
                n += 1
        if n:
            self.note("repos", "stashes", f"{r['path']}: {n}")

    def _checkout_state(self, dest, c, label, fresh, sha):
        """A checkout's uncommitted changes and loose files. A checkout that was
        already here gets the patch only when it sits on the same commit with no
        changes of its own; otherwise the patch is parked, never forced."""
        patch = self.arc(c.get("patch"))
        if patch:
            already = _git(dest, "apply", "--check", "--reverse", "--binary", patch)[0] == 0
            if not already:
                rc, st, _ = _git(dest, "status", "--porcelain", "--untracked-files=no")
                if not fresh and (st.strip() or self._ref(dest, "HEAD") != sha):
                    p = self._keep(patch, f"{_slug(label)}.patch")
                    self.note("repos", "parked", f"{label}: was already here, on other work — "
                              f"the old machine's uncommitted changes are at {p}")
                else:
                    rc, _, err = _git(dest, "apply", "--binary", "--whitespace=nowarn", patch)
                    if rc == 0:
                        self.note("repos", "uncommitted", label)
                    else:
                        p = self._keep(patch, f"{_slug(label)}.patch")
                        self.note("repos", "parked", f"{label}: uncommitted changes didn't "
                                  f"apply ({err.splitlines()[-1] if err else '?'}), kept at {p}")
        n = 0
        for f in c.get("files") or []:
            src = os.path.join(self.root, c["arc"], "files", f)
            dst = os.path.join(dest, f)
            if os.path.lexists(dst) or not os.path.isfile(src):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            n += 1
        if n:
            self.note("repos", "files", f"{label}: {n}")

    def _worktree(self, dest, w):
        wdest = os.path.join(self.m.base, w["path"])
        if os.path.exists(wdest):
            self.note("repos", "present", w["path"])
            return
        os.makedirs(os.path.dirname(wdest), exist_ok=True)
        if w.get("branch") and self._ref(dest, f"refs/heads/{w['branch']}"):
            rc, _, err = _git(dest, "worktree", "add", "-q", wdest, w["branch"])
        elif w.get("sha") and self._has(dest, w["sha"]):
            rc, _, err = _git(dest, "worktree", "add", "-q", "--detach", wdest, w["sha"])
        else:
            self.note("repos", "missing", f"{w['path']}: worktree's commit is on no remote")
            return
        if rc != 0:
            self.note("repos", "failed", f"{w['path']}: worktree add failed ({err[:200]})")
            return
        self.note("repos", "worktrees", w["path"])
        self._checkout_state(wdest, w, w["path"], True, w.get("sha"))

    def _keep(self, src, name) -> str:
        dst = os.path.join(self.park, "repos", name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        os.chmod(dst, 0o600)
        return dst

    def _park_repo(self, r):
        """Everything the file had for a repo that couldn't be restored."""
        if self.dry:
            return
        dst = os.path.join(self.park, "repos", _slug(r.get("path") or "repo"))
        for rel in [r.get("bundle")] + [c.get("arc") for c in
                                          [r.get("main") or {}, *(r.get("worktrees") or [])]]:
            src = self.arc(rel)
            if not src or not os.path.exists(src):
                continue
            target = os.path.join(dst, os.path.basename(src))
            if os.path.isdir(src):
                shutil.copytree(src, target, dirs_exist_ok=True)
            else:
                os.makedirs(dst, exist_ok=True)
                shutil.copy2(src, target)
        if os.path.isdir(dst):
            _write_json(os.path.join(dst, "repo.json"), r)
            self.note("repos", "parked", f"{r.get('path')}: kept at {dst}")

    # -- ~/.claude ---------------------------------------------------------

    def claude(self):
        c = self.man.get("claude") or {}
        for name in c.get("files") or []:
            src = os.path.join(self.root, "claude", name)
            dst = os.path.join(self.m.claude, name)
            if not os.path.isfile(src):
                continue
            with open(src, encoding="utf-8", errors="replace") as f:
                text = self.remap.text(f.read())
            if not os.path.exists(dst):
                if not self.dry:
                    os.makedirs(self.m.claude, exist_ok=True)
                    with open(dst, "w", encoding="utf-8") as f:
                        f.write(text)
                self.note("claude", "added", name)
            else:
                with open(dst, encoding="utf-8", errors="replace") as f:
                    same = f.read() == text
                if not same:
                    stem, ext = os.path.splitext(name)
                    side = f"{stem}.from-{self.host}{ext}"
                    if not self.dry:
                        with open(os.path.join(self.m.claude, side), "w", encoding="utf-8") as f:
                            f.write(text)
                    self.note("claude", "kept", f"{name} (this machine's; the old one is "
                              f"~/.claude/{side})")
        for d, _ in (c.get("dirs") or {}).items():
            src_root = os.path.join(self.root, "claude", d)
            if not os.path.isdir(src_root):
                continue
            for name in sorted(os.listdir(src_root)):
                dst = os.path.join(self.m.claude, d, name)
                if os.path.lexists(dst):
                    self.note("claude", "present", f"{d}/{name}")
                    continue
                if not self.dry:
                    self._copy(os.path.join(src_root, name), dst)
                self.note("claude", "added", f"{d}/{name}")
        for rel in c.get("home_files") or []:
            dst = os.path.join(self.m.home, rel)
            if os.path.lexists(dst):
                continue
            if not self.dry:
                self._copy(os.path.join(self.root, "home", rel), dst)
            self.note("claude", "added", f"~/{rel}")
        # Last, so a hook's script is already in place when _runnable looks for it.
        if isinstance(c.get("settings"), dict):
            self._settings(self.remap.obj(c["settings"]))

    def _will_exist(self, path) -> bool:
        """In a dry run nothing was copied: count what this import would bring."""
        if os.path.exists(path):
            return True
        if not self.dry:
            return False
        c = self.man.get("claude") or {}
        for rel in c.get("home_files") or []:
            if path == os.path.join(self.m.home, rel):
                return True
        if path.startswith(self.m.claude + "/"):
            rel = os.path.relpath(path, self.m.claude)
            return os.path.exists(os.path.join(self.root, "claude", rel))
        return any(path.startswith(os.path.join(self.m.base, r["path"]) + "/")
                   for r in self.man.get("repos") or [] if r.get("path") not in (None, "."))

    def _copy(self, src, dst):
        """Copy with old paths rewritten in text files; mode and mtime kept."""
        if os.path.isdir(src):
            for root, _, names in os.walk(src):
                for n in names:
                    s = os.path.join(root, n)
                    self._copy(s, os.path.join(dst, os.path.relpath(s, src)))
            return
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        st = os.stat(src)
        text = None
        if st.st_size <= 2 * 1024 * 1024:
            try:
                with open(src, encoding="utf-8") as f:
                    text = f.read()
            except (UnicodeDecodeError, OSError):
                text = None
        if text is None:
            shutil.copy2(src, dst)
            return
        with open(dst, "w", encoding="utf-8", newline="") as f:
            f.write(self.remap.text(text))
        os.chmod(dst, stat.S_IMODE(st.st_mode))
        os.utime(dst, (st.st_atime, st.st_mtime))

    def _runnable(self, cmd) -> bool:
        """Can this machine run a hook or status-line command? Its program has to
        resolve, and so does any script it names. A WSL hook calling powershell.exe
        would otherwise fail on every event here."""
        try:
            toks = shlex.split(cmd or "")
        except ValueError:
            toks = (cmd or "").split()
        while toks and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]):
            toks = toks[1:]
        if not toks:
            return False

        def expand(t):
            return _home(t, self.m.home)

        exe = expand(toks[0])
        if "/" in exe:
            if not (os.access(exe, os.X_OK) or (self.dry and self._will_exist(exe))):
                return False
        elif not shutil.which(exe):
            return False
        for t in toks[1:]:
            t = expand(t)
            if t.startswith("/") and re.search(r"\.(?:sh|py|js|mjs|cjs|ts|rb|pl)$", t) \
                    and not self._will_exist(t):
                return False
        return True

    def _settings(self, old):
        path = os.path.join(self.m.claude, "settings.json")
        mine = _read_json(path)
        mine = mine if isinstance(mine, dict) else {}
        old = dict(old)
        hooks, status = old.pop("hooks", None), old.pop("statusLine", None)
        added, conflicts = [], []
        _merge(mine, old, added, conflicts)
        for event, entries in (hooks or {}).items():
            for entry in entries if isinstance(entries, list) else []:
                cmds = [h.get("command", "") for h in (entry or {}).get("hooks") or []
                        if isinstance(h, dict) and h.get("type") == "command"]
                bad = [x for x in cmds if not self._runnable(x)]
                if bad:
                    self.note("claude", "hooks left behind",
                              f"{event}: {bad[0][:90]} (not on this machine)")
                    continue
                lst = mine.setdefault("hooks", {}).setdefault(event, [])
                if entry not in lst:
                    lst.append(entry)
                    added.append(f"hooks.{event}")
        if isinstance(status, dict):
            if "statusLine" not in mine:
                if self._runnable(status.get("command", "")):
                    mine["statusLine"] = status
                    added.append("statusLine")
                else:
                    self.note("claude", "hooks left behind",
                              f"statusLine: {status.get('command', '')[:90]} (not on this machine)")
            elif mine["statusLine"] != status:
                conflicts.append("statusLine")
        if added:
            if not self.dry:
                _backup(path, self.stamp)
                _write_private(path, (json.dumps(mine, indent=2) + "\n").encode())
            self.note("claude", "settings added", ", ".join(sorted(set(added))))
        if conflicts:
            self.note("claude", "settings kept (this machine's)", ", ".join(sorted(set(conflicts))))

    # -- MCP and plugins ---------------------------------------------------

    def mcp(self):
        x = self.man.get("mcp") or {}
        cj = _read_json(self.m.claude_json) or {}
        have = set(cj.get("mcpServers") or {})
        for name, cfg in sorted((x.get("user") or {}).items()):
            if name in have:
                self.note("mcp", "present", name)
            else:
                self._add_mcp(name, self.remap.obj(cfg), "user", self.m.home, name)
        projects = cj.get("projects") or {}
        for old_proj, servers in sorted((x.get("local") or {}).items()):
            proj = self.remap.text(old_proj)
            rel = os.path.relpath(proj, self.m.base) if proj.startswith(self.m.base) else proj
            here = set(((projects.get(proj) or {}).get("mcpServers") or {}))
            for name, cfg in sorted(servers.items()):
                label = f"{name} ({rel})"
                if not (os.path.isdir(proj) or self._will_exist(proj + "/")):
                    self.note("mcp", "left behind", f"{label}: that folder isn't here")
                elif name in here:
                    self.note("mcp", "present", label)
                else:
                    self._add_mcp(name, self.remap.obj(cfg), "local", proj, label)

    def _add_mcp(self, name, cfg, scope, cwd, label):
        if not isinstance(cfg, dict) or name.startswith("-"):
            return
        if self.dry:
            self.note("mcp", "add", label)
            return
        rc, out, err = _claude(["mcp", "add-json", name, json.dumps(cfg), "--scope", scope],
                               cwd=cwd)
        if rc != 0:
            self.note("mcp", "failed", f"{label}: {_last(err or out) or f'exit {rc}'}")
            return
        cmd = cfg.get("command")
        if isinstance(cmd, str) and cmd and not (
                shutil.which(cmd) or os.access(_home(cmd, self.m.home), os.X_OK)):
            self.note("mcp", "added", f"{label} — but its command {cmd} isn't on this machine")
        else:
            self.note("mcp", "added", label)
        if cfg.get("type") in ("http", "sse") and not any(
                k.lower() == "authorization" for k in (cfg.get("headers") or {})):
            self.note("mcp", "may need a login", label)

    def plugins(self):
        x = self.man.get("plugins") or {}
        if not (x.get("marketplaces") or x.get("plugins")):
            return
        have_mk = {mk.get("name") for mk in
                   (_claude_json(["plugin", "marketplace", "list", "--json"]) or [])}
        for mk in x.get("marketplaces") or []:
            if mk["name"] in have_mk:
                self.note("plugins", "present", f"marketplace {mk['name']}")
                continue
            src = self.remap.text(mk["source"])
            if self.dry:
                self.note("plugins", "add", f"marketplace {mk['name']}")
                continue
            rc, out, err = _claude(["plugin", "marketplace", "add", src], cwd=self.m.home)
            self.note("plugins", "added" if rc == 0 else "failed", f"marketplace {mk['name']}" +
                      ("" if rc == 0 else f": {_last(err or out)}"))
        have = {p.get("id") for p in (_claude_json(["plugin", "list", "--json"]) or [])}
        for p in x.get("plugins") or []:
            if p["id"] in have:
                self.note("plugins", "present", p["id"])
                continue
            scope = p["scope"] if p["scope"] in ("user", "project", "local") else "user"
            cwd = self.m.home if scope == "user" else self.remap.text(p.get("project") or "")
            if not cwd or not os.path.isdir(cwd):
                self.note("plugins", "left behind", f"{p['id']}: its project isn't here")
                continue
            if self.dry:
                self.note("plugins", "add", p["id"])
                continue
            rc, out, err = _claude(["plugin", "install", p["id"], "--scope", scope], cwd=cwd)
            if rc != 0:
                self.note("plugins", "failed", f"{p['id']}: {_last(err or out)}")
                continue
            if not p.get("enabled", True):
                _claude(["plugin", "disable", p["id"]], cwd=cwd)
            self.note("plugins", "added", p["id"])

    # -- history -----------------------------------------------------------

    def history(self):
        src = os.path.join(self.root, "claude", "projects")
        if os.path.isdir(src):
            for d in sorted(os.listdir(src)):
                sd = os.path.join(src, d)
                if os.path.isdir(sd):
                    self._history_dir(sd, os.path.join(self.m.projects, self._folder(sd, d)))
        self._prompts()

    def _folder(self, sd, name) -> str:
        """Where a transcript folder goes. Named from the cwd its transcripts record
        when that cwd encodes to the old name; by encoded prefix otherwise (memory-
        only folders, and Claude's shortened names for very long paths)."""
        cwd = None
        for n in sorted(os.listdir(sd)):
            if not n.endswith(".jsonl"):
                continue
            try:
                with open(os.path.join(sd, n), encoding="utf-8", errors="replace") as f:
                    for i, line in enumerate(f):
                        if i > 200:
                            break
                        if '"cwd"' not in line:
                            continue
                        try:
                            o = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(o, dict) and isinstance(o.get("cwd"), str):
                            cwd = o["cwd"]
                            break
            except OSError:
                continue
            if cwd:
                break
        if cwd and _enc(cwd) == name:
            return _enc(self.remap.text(cwd))
        return self.remap.folder(name)

    def _history_dir(self, src, dst):
        copied = present = 0
        for root, _, names in os.walk(src):
            for n in sorted(names):
                s = os.path.join(root, n)
                rel = os.path.relpath(s, src)
                t = os.path.join(dst, rel)
                top = os.sep not in rel and n.endswith(".jsonl")
                if os.path.lexists(t):
                    if rel.replace(os.sep, "/") == "memory/MEMORY.md":
                        self._merge_lines(s, t)
                    elif top:
                        present += 1
                    continue
                if not self.dry:
                    os.makedirs(os.path.dirname(t), exist_ok=True)
                    self._rewrite(s, t)
                if top:
                    copied += 1
        if copied:
            self.note("history", "transcripts", copied)
        if present:
            self.note("history", "present", present)

    def _rewrite(self, src, dst):
        """Copy, swapping old paths line by line (transcripts can be large)."""
        st = os.stat(src)
        if src.endswith((".jsonl", ".json", ".md", ".txt")):
            with open(src, encoding="utf-8", errors="surrogateescape", newline="") as fi, \
                    open(dst, "w", encoding="utf-8", errors="surrogateescape", newline="") as fo:
                for line in fi:
                    fo.write(self.remap.text(line))
            os.chmod(dst, stat.S_IMODE(st.st_mode))
        else:
            shutil.copy2(src, dst)
        os.utime(dst, (st.st_atime, st.st_mtime))      # History orders by it

    def _merge_lines(self, src, dst):
        with open(src, encoding="utf-8", errors="replace") as f:
            old = [self.remap.text(x.rstrip("\n")) for x in f]
        with open(dst, encoding="utf-8", errors="replace") as f:
            mine = f.read()
        have = set(mine.splitlines())
        new = [x for x in old if x.strip() and x not in have]
        if not new:
            return
        if not self.dry:
            with open(dst, "a", encoding="utf-8") as f:
                f.write(("" if mine.endswith("\n") or not mine else "\n") + "\n".join(new) + "\n")
        self.note("history", "memory merged", os.path.basename(os.path.dirname(os.path.dirname(dst))))

    def _prompts(self):
        """~/.claude/history.jsonl, the CLI's prompt history: merged by timestamp."""
        src = os.path.join(self.root, "claude", "history.jsonl")
        if not os.path.isfile(src):
            return
        dst = os.path.join(self.m.claude, "history.jsonl")
        with open(src, encoding="utf-8", errors="replace") as f:
            old = [self.remap.text(x.rstrip("\n")) for x in f if x.strip()]
        mine = []
        if os.path.isfile(dst):
            with open(dst, encoding="utf-8", errors="replace") as f:
                mine = [x.rstrip("\n") for x in f if x.strip()]
        have = set(mine)
        new = [x for x in old if x not in have]
        if not new:
            return
        self.note("history", "prompts", len(new))
        if self.dry:
            return

        def ts(line):
            try:
                return float(json.loads(line).get("timestamp") or 0)
            except (ValueError, AttributeError, TypeError):
                return 0.0

        merged = sorted(mine + new, key=ts)
        size = os.path.getsize(dst) if os.path.isfile(dst) else 0
        tmp = dst + ".mystical-import"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(merged) + "\n")
            # A session here may have appended since we read it: keep that too.
            if os.path.isfile(dst) and os.path.getsize(dst) > size:
                with open(dst, encoding="utf-8", errors="replace") as cur:
                    cur.seek(size)
                    f.write(cur.read())
        os.chmod(tmp, 0o600)
        os.replace(tmp, dst)

    # -- the bridge's own config --------------------------------------------

    def bridge(self):
        b = self.man.get("bridge") or {}
        if b.get("env"):
            with open(os.path.join(self.root, "bridge", "env"), encoding="utf-8",
                      errors="replace") as f:
                self._env(f.read())
        for name in b.get("state") or []:
            self._state(name, os.path.join(self.root, "bridge", "state", name),
                        os.path.join(self.m.state, name))
        for name in b.get("mystical") or []:
            dst = self.m.freeagents if name == "freeagents.json" else self.m.weather
            self._state(name, os.path.join(self.root, "bridge", "mystical", name), dst)
        if b.get("db"):
            dst = os.path.join(self.park, "bridge.db")
            if not self.dry:
                os.makedirs(self.park, exist_ok=True)
                shutil.copy2(os.path.join(self.root, "bridge", "bridge.db"), dst)
                os.chmod(dst, 0o600)
            # ponytail: parked, not merged. The conversations are already in the
            # transcripts above; what only the DB has (renamed titles, goals, turn
            # costs) needs a merge across two live schema versions, its own job.
            self.note("bridge", "parked", f"the old bridge.db, at {dst}")

    def _env(self, text):
        old = _parse_env(text)
        path = self.m.env_file
        mine_text = ""
        if os.path.isfile(path):
            with open(path, encoding="utf-8", errors="replace") as f:
                mine_text = f.read()
        mine = dict(_parse_env(mine_text))
        add, kept, behind = [], [], []
        for k, v in old:
            v = self.remap.text(v)
            if k in _ENV_LOCAL:
                behind.append(k)
            elif k in mine:
                if mine[k] != v:
                    kept.append(k)
            elif k not in dict(add):
                add.append((k, v))
        if add and not self.dry:
            _backup(path, self.stamp)
            body = mine_text + ("" if mine_text.endswith("\n") or not mine_text else "\n")
            body += (f"\n# Carried from {self.host} by `mystical import`, "
                     f"{time.strftime('%Y-%m-%d')}.\n")
            body += "".join(f"{k}={v}\n" for k, v in add)
            _write_private(path, body.encode())
        if add:
            self.note("bridge", ".env added", ", ".join(k for k, _ in add))
        if kept:
            self.note("bridge", ".env kept (this machine's)", ", ".join(kept))
        if behind:
            self.note("bridge", ".env left behind (per machine)", ", ".join(behind))

    def _state(self, name, src, dst):
        old = _read_json(src)
        if not isinstance(old, dict):
            return
        old = self.remap.obj(old)
        if name == "env_settings.json":
            old = {k: v for k, v in old.items() if k not in _ENV_LOCAL}
        off = []
        if name == "rivendell_instances.json":
            for iid, inst in (old.get("instances") or {}).items():
                if isinstance(inst, dict):
                    inst["enable"] = False
                    off.append(inst.get("name") or iid)
        mine = _read_json(dst)
        if not isinstance(mine, dict):
            if not self.dry:
                _write_json(dst, old)
            self.note("bridge", "state added", name)
        else:
            added, conflicts = [], []
            _merge(mine, old, added, conflicts)
            if added:
                if not self.dry:
                    _backup(dst, self.stamp)
                    _write_json(dst, mine)
                self.note("bridge", "state merged", name)
        if off:
            self.note("bridge", "rivendell (OFF)", ", ".join(off))

    # -- the report --------------------------------------------------------

    def finish(self):
        if not self.dry:
            os.makedirs(self.park, exist_ok=True)
            _write_json(os.path.join(self.park, f"import-{self.stamp}.json"), self.rep)
        log = self.log
        log("")
        for section in ("repos", "claude", "mcp", "plugins", "history", "bridge"):
            got = self.rep.get(section)
            if not got:
                continue
            log(f"{section}")
            for key, items in got.items():
                if all(isinstance(i, int) for i in items):
                    log(f"  {key:<14} {sum(items)}")
                    continue
                shown = ", ".join(str(i) for i in items[:10])
                more = f" … and {len(items) - 10} more" if len(items) > 10 else ""
                log(f"  {key:<14} {len(items):>3}  {shown}{more}")
        nxt = []
        if self.rep.get("bridge", {}).get(".env added") or \
                any(k in self.rep.get("bridge", {}) for k in ("state added", "state merged")):
            nxt.append("Restart the bridge so the new .env and settings load.")
        if self.rep.get("bridge", {}).get("rivendell (OFF)"):
            nxt.append("Rivendell came over switched OFF. Turn it on (Settings ▸ PLUGINS) only "
                       "once the old machine's bridge is stopped, or both will run its jobs.")
        if self.rep.get("mcp", {}).get("may need a login"):
            nxt.append("MCP servers that sign in with OAuth need it once more here: "
                       "dashboard ▸ MCP ▸ re-authenticate.")
        if not self.dry and (self.rep.get("repos", {}).get("parked") or
                             self.rep.get("bridge", {}).get("parked")):
            nxt.append(f"What wasn't applied is kept at {self.park} — nothing was dropped.")
        if nxt:
            log("")
            for n in nxt:
                log(f"  → {n}")


def _merge(mine: dict, theirs: dict, added: list, conflicts: list, path="") -> dict:
    """theirs into mine: missing keys added, lists unioned, mine wins a conflict."""
    for k, v in theirs.items():
        p = f"{path}.{k}" if path else k
        if k not in mine:
            mine[k] = v
            added.append(p)
        elif isinstance(mine[k], dict) and isinstance(v, dict):
            _merge(mine[k], v, added, conflicts, p)
        elif isinstance(mine[k], list) and isinstance(v, list):
            new = [x for x in v if x not in mine[k]]
            if new:
                mine[k] = mine[k] + new
                added.append(p)
        elif mine[k] != v:
            conflicts.append(p)
    return mine


def _parse_env(text) -> "list[tuple[str, str]]":
    """KEY=value pairs as written (quotes kept), a quoted value spanning lines whole."""
    out = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        mt = _ENV_LINE.match(lines[i])
        i += 1
        if not mt:
            continue
        key, val = mt.group(1), mt.group(2)
        q = val[:1]
        if q in ("'", '"') and (len(val) == 1 or not val.rstrip().endswith(q)):
            while i < len(lines):
                val += "\n" + lines[i]
                i += 1
                if lines[i - 1].rstrip().endswith(q):
                    break
        out.append((key, val))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mystical", description="Move this bridge to another "
                                 "machine: export here, import there.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="write one file holding repos, MCPs, settings and history")
    e.add_argument("--out", help="where to write it (default: ~/mystical-move-<host>-<time>.tar.gz)")
    e.add_argument("--no-history", action="store_true", help="leave the chat transcripts out")
    i = sub.add_parser("import", help="replay an export onto this machine")
    i.add_argument("file")
    i.add_argument("--dry-run", action="store_true", help="say what would happen, change nothing")
    a = ap.parse_args(argv)
    if a.cmd == "export":
        export(a.out, history=not a.no_history)
    else:
        import_file(a.file, dry=a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
