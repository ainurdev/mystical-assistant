"""Moving a bridge between machines (bridge/move.py): export on one, import on
the other.

The round trip stands two machines side by side in a temp dir, with different
homes and BASE_PATHs, real git repos (one with a bare "remote", one with no
remote at all) and a fake `claude` CLI, so the suite never reaches the real
~/.claude.json. It checks what the module promises: work no remote has comes
back exactly (branches, stash, uncommitted changes, untracked and ignored
config files, a linked worktree), history lands under this machine's paths with
its mtimes, settings merge without overwriting, and the per-machine things (bot
token, BASE_PATH, a live Rivendell link) never move. Also that export leaves the
old repo untouched and that a second import changes nothing.
"""

import json
import os
import sqlite3
import stat
import subprocess
import tarfile

import pytest

from bridge import move

OLD_MTIME = 1_700_000_000


def _git(cwd, *args) -> str:
    return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True,
                          text=True).stdout.strip()


def _write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)


class FakeClaude:
    """Stands in for the `claude` CLI on whichever machine is current. add-json
    writes the server into that machine's ~/.claude.json, the way the real one
    does, so a second import sees it."""

    def __init__(self):
        self.calls = []
        self.machine = None
        self.marketplaces = []
        self.plugins = []

    def __call__(self, args, cwd=None):
        self.calls.append((list(args), cwd))
        if args[:1] == ["--version"]:
            return 0, "2.1.294 (Claude Code)\n", ""
        if args[:3] == ["plugin", "marketplace", "list"]:
            return 0, json.dumps(self.marketplaces), ""
        if args[:2] == ["plugin", "list"]:
            return 0, json.dumps(self.plugins), ""
        if args[:2] == ["mcp", "add-json"]:
            name, cfg, scope = args[2], json.loads(args[3]), args[5]
            cj = json.load(open(self.machine.claude_json)) \
                if os.path.exists(self.machine.claude_json) else {}
            if scope == "user":
                cj.setdefault("mcpServers", {})[name] = cfg
            else:
                cj.setdefault("projects", {}).setdefault(cwd, {}).setdefault(
                    "mcpServers", {})[name] = cfg
            _write(self.machine.claude_json, json.dumps(cj))
            return 0, "", ""
        if args[:2] == ["plugin", "install"]:
            self.plugins.append({"id": args[2], "scope": args[4], "enabled": True})
            return 0, "", ""
        return 0, "", ""

    def added(self, prefix):
        return [(a, cwd) for a, cwd in self.calls if a[:len(prefix)] == prefix]


@pytest.fixture
def world(tmp_path, monkeypatch):
    """An old machine full of state and a fresh new one."""
    root = os.path.realpath(str(tmp_path))
    gitcfg = os.path.join(root, "gitconfig")
    _write(gitcfg, "[user]\n\tname = T\n\temail = t@t\n[init]\n\tdefaultBranch = main\n"
                   "[commit]\n\tgpgsign = false\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", gitcfg)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    fake = FakeClaude()
    monkeypatch.setattr(move, "_claude", fake)
    monkeypatch.setattr(move, "_github_ssh_ok", lambda: pytest.fail("no GitHub remote here"))

    # --- the old machine -------------------------------------------------
    oh = os.path.join(root, "old", "home", "u")
    ob = os.path.join(oh, "projects")
    old = move.Machine(home=oh, base=ob, db=os.path.join(oh, ".bridge_state", "bridge.db"),
                       env_file=os.path.join(root, "old", "mystical", ".env"),
                       mystical=os.path.join(oh, ".mystical"))

    bare = os.path.join(root, "remotes", "app.git")
    os.makedirs(bare)
    _git(bare, "init", "-q", "--bare", "-b", "main")
    app = os.path.join(ob, "acme", "app")
    os.makedirs(os.path.dirname(app))
    subprocess.run(["git", "clone", "-q", bare, app], check=True, capture_output=True)
    _write(os.path.join(app, ".gitignore"), ".env\n")
    _write(os.path.join(app, "a.txt"), "one\n")
    _git(app, "add", ".")
    _git(app, "commit", "-qm", "pushed")
    _git(app, "push", "-q", "-u", "origin", "main")
    _write(os.path.join(app, "b.txt"), "two\n")
    _git(app, "add", "b.txt")
    _git(app, "commit", "-qm", "unpushed on main")
    _git(app, "checkout", "-q", "-b", "feat")
    _write(os.path.join(app, "f.txt"), "feat\n")
    _git(app, "add", "f.txt")
    _git(app, "commit", "-qm", "feat only")
    _git(app, "checkout", "-q", "main")
    _write(os.path.join(app, "a.txt"), "one\nstashed\n")
    _git(app, "stash", "-q")
    _write(os.path.join(app, "a.txt"), "one\ndirty\n")
    _write(os.path.join(app, "new.txt"), "untracked\n")
    _write(os.path.join(app, ".env"), "SECRET=1\n")
    _write(os.path.join(app, ".mystical", ".gitignore"), "*\n")
    _write(os.path.join(app, ".mystical", "learn", "l.md"), "lesson\n")
    _write(os.path.join(app, ".mystical", "dev.log"), "noise\n")
    wt = os.path.join(ob, ".worktrees", "acme-app", "wt")
    _git(app, "worktree", "add", "-q", "-b", "wtb", wt)
    _write(os.path.join(wt, "a.txt"), "one\nwt change\n")
    _write(os.path.join(wt, "wt-new.txt"), "wt untracked\n")

    solo = os.path.join(ob, "solo")
    os.makedirs(solo)
    _git(solo, "init", "-q", "-b", "main")
    for n in ("1", "2"):
        _write(os.path.join(solo, n), n)
        _git(solo, "add", n)
        _git(solo, "commit", "-qm", n)
    _write(os.path.join(ob, "notes", "todo.txt"), "not a repo\n")

    _write(old.claude_json, json.dumps({
        "mcpServers": {
            "ctx": {"type": "stdio", "command": "sh", "args": [f"{oh}/tools/ctx.sh"]},
            "web": {"type": "http", "url": "https://web.example/mcp"},
            "docs": {"type": "http", "url": "https://docs.example/mcp"}},
        "projects": {
            app: {"mcpServers": {"db": {"type": "stdio", "command": "sh", "args": ["-c", "true"]}}},
            f"{ob}/gone": {"mcpServers": {"g": {"type": "stdio", "command": "sh"}}}}}))
    hooks_dir = os.path.join(oh, ".claude", "hooks")
    _write(os.path.join(hooks_dir, "stop.sh"), f"#!/bin/sh\necho {oh}\n", 0o755)
    _write(os.path.join(oh, ".claude", "statusline.sh"), "#!/bin/sh\necho hi\n", 0o755)
    _write(os.path.join(oh, ".claude", "settings.json"), json.dumps({
        "model": "opus",
        "permissions": {"allow": ["Bash(ls:*)"]},
        "env": {"FOO": "1"},
        "hooks": {"Stop": [
            {"hooks": [{"type": "command", "command": f"sh {hooks_dir}/stop.sh"}]},
            {"hooks": [{"type": "command", "command": "powershell.exe -c beep"}]}]},
        "statusLine": {"type": "command", "command": f"{oh}/.claude/statusline.sh"}}))
    _write(os.path.join(oh, ".claude", "CLAUDE.md"), f"Projects live in {ob}.\n")
    _write(os.path.join(oh, ".claude", "skills", "mine", "SKILL.md"), f"see {oh}/x\n")
    _write(os.path.join(oh, ".claude", "skills", "synced", "acct", "SKILL.md"), "account\n")

    enc_app = move._enc(app)
    tdir = os.path.join(old.projects, enc_app)
    _write(os.path.join(tdir, "s1.jsonl"),
           json.dumps({"type": "summary", "summary": "x"}) + "\n" +
           json.dumps({"type": "user", "cwd": app, "message": {"content": f"edit {app}/a.txt"}})
           + "\n")
    os.utime(os.path.join(tdir, "s1.jsonl"), (OLD_MTIME, OLD_MTIME))
    _write(os.path.join(tdir, "s1", "subagents", "agent-1.jsonl"),
           json.dumps({"cwd": app}) + "\n")
    _write(os.path.join(tdir, "memory", "MEMORY.md"), "- [old](old.md) — from the old box\n")
    _write(os.path.join(old.projects, move._enc(oh), "s2.jsonl"), json.dumps({"cwd": oh}) + "\n")
    _write(os.path.join(oh, ".claude", "history.jsonl"),
           json.dumps({"display": "old prompt", "timestamp": 1000, "project": app}) + "\n")

    _write(os.path.join(old.state, "rivendell_instances.json"), json.dumps({"instances": {
        "production": {"id": "production", "name": "production", "enable": True,
                       "token": "rvd_secret", "workdir": app}}}))
    _write(os.path.join(old.state, "trackers.json"), json.dumps({"connections": {"c1": {"x": 1}}}))
    _write(os.path.join(old.state, "ai_features.json"), json.dumps({"title": False, "ponytail": True}))
    _write(os.path.join(old.state, "nextup.json"), json.dumps({"cache": True}))
    db = sqlite3.connect(old.db)
    db.execute("CREATE TABLE sessions(id TEXT)")
    db.execute("INSERT INTO sessions VALUES('s')")
    db.commit()
    db.close()
    _write(old.env_file, "\n".join([
        'TELEGRAM_BOT_TOKEN="old-bot"', f'BASE_PATH="{ob}"', 'RIVENDELL_ENABLE="1"',
        'RIVENDELL_TOKEN="rvd_secret"', 'START_CMD="npm start"', 'EXTRA_CLAUDE_ARGS="--old"',
        "export DASH_CHAT_ID=42", 'ASK_SYSTEM_PROMPT="line one', 'line two"',
        f'RIVENDELL_WORKDIR="{app}"']) + "\n")
    _write(old.freeagents, json.dumps({"groq": "k"}))

    # --- the new machine -------------------------------------------------
    nh = os.path.join(root, "new", "Users", "m")
    nb = os.path.join(nh, "Projects")
    os.makedirs(nb)
    new = move.Machine(home=nh, base=nb, db=os.path.join(nh, ".bridge_state", "bridge.db"),
                       env_file=os.path.join(root, "new", "mystical", ".env"),
                       mystical=os.path.join(nh, ".mystical"))
    _write(new.env_file, f'TELEGRAM_BOT_TOKEN="new-bot"\nBASE_PATH="{nb}"\n'
                         'EXTRA_CLAUDE_ARGS="--new"\n', 0o600)
    _write(os.path.join(nh, ".claude", "settings.json"), json.dumps({
        "theme": "dark", "model": "sonnet",
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "true"}]}]}}))
    _write(new.claude_json, json.dumps({"mcpServers": {
        "web": {"type": "http", "url": "https://web.example/mcp"}}}))
    _write(os.path.join(new.state, "ai_features.json"), json.dumps({"title": True}))

    return {"root": root, "old": old, "new": new, "fake": fake, "app": app, "wt": wt,
            "solo": solo}


def _export(w, **kw):
    w["fake"].machine = w["old"]
    w["fake"].marketplaces = [
        {"name": "claude-plugins-official", "source": "github",
         "repo": "anthropics/claude-plugins-official"},
        {"name": "mk1", "source": "github", "repo": "acme/mk1"}]
    w["fake"].plugins = [{"id": "p1@mk1", "scope": "user", "enabled": True},
                         {"id": "s@synced", "scope": "synced", "enabled": True}]
    out = os.path.join(w["root"], "move.tar.gz")
    return move.export(out, m=w["old"], log=lambda *a: None, **kw)


def _import(w, path, dry=False):
    w["fake"].machine = w["new"]
    w["fake"].marketplaces = [{"name": "claude-plugins-official", "source": "github",
                               "repo": "anthropics/claude-plugins-official"}]
    w["fake"].plugins = []
    return move.import_file(path, m=w["new"], dry=dry, log=lambda *a: None)


def _state_of(repo):
    """Everything export must not change."""
    return (_git(repo, "for-each-ref"), _git(repo, "status", "--porcelain"),
            _git(repo, "stash", "list"), _git(repo, "worktree", "list"))


# --- the round trip ----------------------------------------------------------

def test_export_writes_one_private_file_and_leaves_the_repos_alone(world):
    before = _state_of(world["app"])
    path = _export(world)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert _state_of(world["app"]) == before
    assert "refs/mystical" not in _git(world["app"], "for-each-ref")
    with tarfile.open(path) as tar:
        members = tar.getmembers()
        names = [x.name for x in members]
        man = json.load(tar.extractfile("manifest.json"))
    assert all(x.isfile() for x in members), "no links for the import's filter to refuse"
    assert man["loose"] == ["notes/"]
    assert [r["path"] for r in man["repos"]] == ["acme/app", "solo"]
    app = man["repos"][0]
    assert app["unpushed"] == 4      # main's, feat's, and the stash's work + index commits
    assert "nextup.json" not in man["bridge"]["state"], "a cache is not configuration"
    assert not any(n.startswith("claude/skills/synced") for n in names)
    assert not any(n.endswith("dev.log") for n in names)


def test_repos_come_back_exactly(world):
    old_main = _git(world["app"], "rev-parse", "main")
    old_feat = _git(world["app"], "rev-parse", "feat")
    old_stash = _git(world["app"], "rev-parse", "stash@{0}")
    rep = _import(world, _export(world))
    app = os.path.join(world["new"].base, "acme", "app")
    assert _git(app, "rev-parse", "main") == old_main
    assert _git(app, "rev-parse", "feat") == old_feat
    assert _git(app, "symbolic-ref", "--short", "HEAD") == "main"
    assert _git(app, "rev-parse", "stash@{0}") == old_stash
    assert _git(app, "remote", "get-url", "origin").endswith("remotes/app.git")
    assert open(os.path.join(app, "a.txt")).read() == "one\ndirty\n"
    assert open(os.path.join(app, "new.txt")).read() == "untracked\n"
    assert open(os.path.join(app, ".env")).read() == "SECRET=1\n"
    assert os.path.isfile(os.path.join(app, ".mystical", "learn", "l.md"))
    assert not os.path.exists(os.path.join(app, ".mystical", "dev.log"))
    assert "refs/mystical-move" not in _git(app, "for-each-ref")

    wt = os.path.join(world["new"].base, ".worktrees", "acme-app", "wt")
    assert _git(wt, "symbolic-ref", "--short", "HEAD") == "wtb"
    assert open(os.path.join(wt, "a.txt")).read() == "one\nwt change\n"
    assert open(os.path.join(wt, "wt-new.txt")).read() == "wt untracked\n"

    solo = os.path.join(world["new"].base, "solo")
    assert _git(solo, "rev-list", "--count", "HEAD") == "2"
    assert _git(solo, "remote") == "", "a repo with no remote gets none, not the bundle path"
    assert not os.path.exists(os.path.join(world["new"].base, "notes"))
    assert not rep["repos"].get("failed"), rep["repos"]


def test_mcp_and_plugins_go_through_the_cli(world):
    rep = _import(world, _export(world))
    fake, new = world["fake"], world["new"]
    adds = {a[2]: (a, cwd) for a, cwd in fake.added(["mcp", "add-json"])}
    assert set(adds) == {"ctx", "docs", "db"}, "web was already here; g's folder isn't"
    ctx_args, _ = adds["ctx"]
    assert json.loads(ctx_args[3])["args"] == [f"{new.home}/tools/ctx.sh"]
    assert ctx_args[4:] == ["--scope", "user"]
    db_args, db_cwd = adds["db"]
    assert db_args[4:] == ["--scope", "local"]
    assert db_cwd == os.path.join(new.base, "acme", "app")
    assert rep["mcp"]["may need a login"] == ["docs"]
    assert [a for a, _ in fake.added(["plugin", "marketplace", "add"])] == \
        [["plugin", "marketplace", "add", "acme/mk1"]]
    assert [a for a, _ in fake.added(["plugin", "install"])] == \
        [["plugin", "install", "p1@mk1", "--scope", "user"]]


def test_claude_settings_merge_and_machine_specific_hooks_stay(world):
    rep = _import(world, _export(world))
    new = world["new"]
    s = json.load(open(os.path.join(new.claude, "settings.json")))
    assert s["theme"] == "dark" and s["model"] == "sonnet", "this machine wins a conflict"
    assert s["permissions"]["allow"] == ["Bash(ls:*)"]
    assert s["env"] == {"FOO": "1"}
    stop = [h["command"] for e in s["hooks"]["Stop"] for h in e["hooks"]]
    assert stop == ["true", f"sh {new.claude}/hooks/stop.sh"]
    assert s["statusLine"]["command"] == f"{new.claude}/statusline.sh"
    assert any("powershell.exe" in x for x in rep["claude"]["hooks left behind"])
    assert "model" in rep["claude"]["settings kept (this machine's)"][0]
    assert open(os.path.join(new.claude, "CLAUDE.md")).read() == \
        f"Projects live in {new.base}.\n"
    assert open(os.path.join(new.claude, "skills", "mine", "SKILL.md")).read() == \
        f"see {new.home}/x\n"
    assert not os.path.exists(os.path.join(new.claude, "skills", "synced"))
    assert os.access(os.path.join(new.claude, "hooks", "stop.sh"), os.X_OK)


def test_history_lands_under_this_machines_paths(world):
    _import(world, _export(world))
    new = world["new"]
    app = os.path.join(new.base, "acme", "app")
    tdir = os.path.join(new.projects, move._enc(app))
    s1 = os.path.join(tdir, "s1.jsonl")
    lines = [json.loads(x) for x in open(s1)]
    assert lines[1]["cwd"] == app
    assert lines[1]["message"]["content"] == f"edit {app}/a.txt"
    assert os.stat(s1).st_mtime == OLD_MTIME, "History orders by mtime"
    assert os.path.isfile(os.path.join(tdir, "s1", "subagents", "agent-1.jsonl"))
    assert "from the old box" in open(os.path.join(tdir, "memory", "MEMORY.md")).read()
    assert os.path.isfile(os.path.join(new.projects, move._enc(new.home), "s2.jsonl"))
    prompts = [json.loads(x) for x in open(os.path.join(new.claude, "history.jsonl"))]
    assert prompts == [{"display": "old prompt", "timestamp": 1000, "project": app}]


def test_bridge_config_merges_and_per_machine_keys_stay_behind(world):
    rep = _import(world, _export(world))
    new = world["new"]
    env = open(new.env_file).read()
    assert stat.S_IMODE(os.stat(new.env_file).st_mode) == 0o600
    assert env.count("TELEGRAM_BOT_TOKEN") == 1 and 'TELEGRAM_BOT_TOKEN="new-bot"' in env
    assert 'EXTRA_CLAUDE_ARGS="--new"' in env and "--old" not in env
    assert "RIVENDELL_ENABLE" not in env
    assert env.count("BASE_PATH") == 1
    for line in ('START_CMD="npm start"', 'RIVENDELL_TOKEN="rvd_secret"', "DASH_CHAT_ID=42",
                 'ASK_SYSTEM_PROMPT="line one\nline two"',
                 f'RIVENDELL_WORKDIR="{new.base}/acme/app"'):
        assert line in env
    assert any(n.startswith(".env.bak-") for n in os.listdir(os.path.dirname(new.env_file)))
    assert set(rep["bridge"][".env left behind (per machine)"][0].split(", ")) == \
        {"TELEGRAM_BOT_TOKEN", "BASE_PATH", "RIVENDELL_ENABLE"}

    inst = json.load(open(os.path.join(new.state, "rivendell_instances.json")))
    prod = inst["instances"]["production"]
    assert prod["enable"] is False, "two linked bridges would both run every job"
    assert prod["workdir"] == f"{new.base}/acme/app"
    assert json.load(open(os.path.join(new.state, "ai_features.json"))) == \
        {"title": True, "ponytail": True}
    assert json.load(open(os.path.join(new.state, "trackers.json")))["connections"] == \
        {"c1": {"x": 1}}
    assert json.load(open(new.freeagents)) == {"groq": "k"}
    parked = os.path.join(new.state, "moved")
    host = os.listdir(parked)[0]
    db = sqlite3.connect(os.path.join(parked, host, "bridge.db"))
    assert db.execute("SELECT id FROM sessions").fetchall() == [("s",)]
    db.close()


def test_a_second_import_changes_nothing(world):
    path = _export(world)
    _import(world, path)
    new = world["new"]
    app = os.path.join(new.base, "acme", "app")
    snap = (open(new.env_file).read(), open(os.path.join(new.claude, "settings.json")).read(),
            _git(app, "stash", "list"), _git(app, "for-each-ref"),
            _git(app, "status", "--porcelain"))
    world["fake"].calls.clear()
    rep = _import(world, path)
    assert snap == (open(new.env_file).read(),
                    open(os.path.join(new.claude, "settings.json")).read(),
                    _git(app, "stash", "list"), _git(app, "for-each-ref"),
                    _git(app, "status", "--porcelain"))
    assert not world["fake"].added(["mcp", "add-json"])
    assert sorted(rep["repos"]["present"]) == [".worktrees/acme-app/wt", "acme/app", "solo"]
    assert not rep["repos"].get("parked"), rep["repos"]


def test_dry_run_changes_nothing(world):
    path = _export(world)
    new = world["new"]
    env_before = open(new.env_file).read()
    settings_before = open(os.path.join(new.claude, "settings.json")).read()
    rep = _import(world, path, dry=True)
    assert os.listdir(new.base) == []
    assert open(new.env_file).read() == env_before
    assert open(os.path.join(new.claude, "settings.json")).read() == settings_before
    assert not os.path.exists(new.projects)
    assert not os.path.exists(os.path.join(new.state, "moved"))
    assert not world["fake"].added(["mcp", "add-json"])
    assert sorted(rep["repos"]["clone"][i].split(" ")[0] for i in range(2)) == ["acme/app", "solo"]
    assert rep["mcp"]["add"] == ["ctx", "docs", "db (acme/app)"]
    assert not any("stop.sh" in x for x in rep["claude"].get("hooks left behind", [])), \
        "a hook whose script this import brings is judged as if it were here"


def test_an_existing_different_repo_is_never_overwritten(world):
    path = _export(world)
    taken = os.path.join(world["new"].base, "acme", "app")
    os.makedirs(taken)
    _write(os.path.join(taken, "mine.txt"), "keep me\n")
    rep = _import(world, path)
    assert os.listdir(taken) == ["mine.txt"]
    assert rep["repos"]["skipped"] == ["acme/app: something else is already there"]
    parked = rep["repos"]["parked"][0]
    assert "acme/app: kept at" in parked
    assert os.path.isfile(os.path.join(parked.split("kept at ")[1], "unpushed.bundle"))


def test_a_checkout_already_here_on_other_work_gets_the_patch_parked(world):
    path = _export(world)
    app = os.path.join(world["new"].base, "acme", "app")
    subprocess.run(["git", "clone", "-q", os.path.join(world["root"], "remotes", "app.git"),
                    app], check=True, capture_output=True)
    rep = _import(world, path)
    assert open(os.path.join(app, "a.txt")).read() == "one\n", "its own checkout is untouched"
    assert _git(app, "rev-parse", "main") != _git(world["app"], "rev-parse", "main")
    host = os.listdir(os.path.join(world["new"].state, "moved"))[0]
    assert _git(app, "rev-parse", f"moved/{host}/main") == _git(world["app"], "rev-parse", "main")
    assert any(x.startswith("acme/app: was already here") for x in rep["repos"]["parked"])
    assert _git(app, "rev-parse", "feat") == _git(world["app"], "rev-parse", "feat")


# --- the pieces --------------------------------------------------------------

def test_claude_calls_target_the_main_login(monkeypatch):
    seen = {}
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/somewhere/accounts/2")
    monkeypatch.setattr(move.subprocess, "run", lambda argv, **kw: seen.update(kw) or
                        subprocess.CompletedProcess(argv, 0, b"", b""))
    move._claude(["mcp", "list"])
    assert "CLAUDE_CONFIG_DIR" not in seen["env"], "a second account's slot isn't where MCPs live"


def test_remap_matches_whole_path_segments_longest_first():
    r = move.Remap([("/home/u/projects", "/Users/m/Projects"), ("/home/u", "/Users/m")])
    assert r.text("/home/u/projects/app") == "/Users/m/Projects/app"
    assert r.text("cd /home/u/projects") == "cd /Users/m/Projects"
    assert r.text("/home/u/projects-old/x") == "/Users/m/projects-old/x"
    assert r.text("/home/u2/x and /home/u.bak") == "/home/u2/x and /home/u.bak"
    assert r.text("Projects live in /home/u/projects.") == "Projects live in /Users/m/Projects."
    assert r.text('{"cwd":"/home/u"}') == '{"cwd":"/Users/m"}'
    assert r.folder("-home-u-projects-acme-app") == "-Users-m-Projects-acme-app"
    assert r.folder("-home-u") == "-Users-m"
    assert r.folder("-tmp-x") == "-tmp-x"
    assert move.Remap([("/home/u", "/home/u")]).text("/home/u/x") == "/home/u/x"


def test_one_spelling_per_remote():
    same = {move._norm_url(u) for u in (
        "git@github.com:Acme/App.git", "https://github.com/acme/app",
        "ssh://git@github.com/acme/app.git", "https://user@github.com/acme/app.git/")}
    assert same == {"github.com/acme/app"}
    assert move._norm_url("ssh://git@host:2222/a/b.git") == "host:2222/a/b"


def test_github_ssh_remotes_move_to_https_when_the_key_is_refused():
    imp = move._Import.__new__(move._Import)
    imp._https = True
    assert imp._transport("git@github.com:acme/app.git") == "https://github.com/acme/app.git"
    assert imp._transport("ssh://git@github.com/acme/app") == "https://github.com/acme/app.git"
    assert imp._transport("git@gitlab.com:acme/app.git") == "git@gitlab.com:acme/app.git"
    imp._https = False
    assert imp._transport("git@github.com:acme/app.git") == "git@github.com:acme/app.git"


def test_env_parsing_keeps_values_as_written():
    got = move._parse_env('# c\nA="x y"\nexport B=2\nC="multi\nline"\nD=\'q\'\n  \nnot a line\n')
    assert got == [("A", '"x y"'), ("B", "2"), ("C", '"multi\nline"'), ("D", "'q'")]


def test_config_files_are_carried_and_examples_are_not():
    for p in (".env", "apps/web/.env.local", "prod.env", ".envrc", "CLAUDE.local.md",
              ".claude/settings.local.json", "x/.claude/settings.local.json", ".mcp.json"):
        assert move._is_config(p), p
    for p in (".env.example", ".env.sample", "node_modules/x.js", "dist/app.js"):
        assert not move._is_config(p), p
