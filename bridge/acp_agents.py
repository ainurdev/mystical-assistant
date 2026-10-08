"""Which non-Claude agents a session may run on, under which account, with
which environment. bridge/acp.py speaks the protocol; this module decides
what it is allowed to start.

Safety rules (spec: profiles-and-acp-agents.md) live here, in code:
  1. PRESETS is the whole list. There is no custom command anywhere. Each entry
     is a vendor's own CLI, or the ACP org's official adapter that runs it.
     Left out on purpose:
     - Copilot: its ACP mode auto-approves everything, copilot-cli#4537.
     - Antigravity: its terms §6 ban third-party access.
     - Amp: no client approvals.
     - Droid: context leaks across sessions, #46.
     - Gemini with a Google login: consumer logins are dead since 2026-06-18,
       and piggybacking on one is a ban, so the preset is API key only.
  2. No login token is ever read. A subscription login happens in the CLI's
     own flow (login_hint() shows the command). The only secrets kept are
     pasted API keys: ACCOUNTS_FILE, 0600, returned masked.
  3. env_for() builds the child env from an allow-list. The bridge's own env
     holds the Telegram bot token, the dashboard token, Rivendell/GitHub/
     tracker tokens, and maybe Anthropic credentials. None of that goes to a
     third-party CLI, and neither do other agents' keys.
  4. is_claude_model(): Claude models run only through the claude CLI.
  6. run_problem(): agent turns run only in the owner's chat, one person per
     login.

Account kinds:
  - "" (machine login): whatever the CLI is logged into here.
  - key: a pasted API key, set as the preset's key var.
  - home: a separate login in its own 0700 dir, set as the preset's home var.
    The user runs login_hint() once in a terminal.

The options cache keeps each agent's advertised config options (model, mode,
thought level) as last seen by a turn or a TEST. The pickers are built from
it, never from hard-coded ids: every agent invents its own.

Stdlib only.
"""

import glob
import json
import os
import re
import shutil
import threading
import uuid

from bridge import config

PRESETS = (
    # codex-acp runs OpenAI's own `codex app-server`; pin bumped deliberately.
    # 2.1.1 depends on @openai/codex ^0.159.1 and runs that bundled binary (its
    # README: "The npm package includes a compatible @openai/codex dependency"),
    # so only npx is needed, and login goes through the same npm package
    # (`codex login --device-auth`: OpenAI's auth docs, headless sign-in).
    {"id": "codex", "label": "Codex", "cmd": ["npx", "-y", "@agentclientprotocol/codex-acp@2.1.1"],
     "key_env": "OPENAI_API_KEY", "home_env": "CODEX_HOME", "key_required": False,
     "login": "npx -y @openai/codex login --device-auth", "install": "Node.js 18+ (for npx)",
     "env": {}},
    {"id": "opencode", "label": "opencode", "cmd": ["opencode", "acp"],
     "key_env": None, "home_env": "XDG_DATA_HOME", "key_required": False,
     "login": "opencode auth login",
     "install": "curl -fsSL https://opencode.ai/install | bash",
     # opencode ships allow-all; ask for anything that writes or reaches out (rule 7).
     # Checked in 1.18.10: the binary JSON.parses OPENCODE_PERMISSION and merges it
     # over config.permission; defaults are "*":"allow"; websearch is its own key
     # (opencode.ai/docs/permissions). A live edit turn raised the card.
     "env": {"OPENCODE_DISABLE_AUTOUPDATE": "1",
             "OPENCODE_PERMISSION": json.dumps({"edit": "ask", "bash": "ask", "webfetch": "ask",
                                                "websearch": "ask"})}},
    # --acp checked in @google/gemini-cli 0.63.0 (yargs: --experimental-acp "deprecated, use --acp").
    {"id": "gemini", "label": "Gemini CLI", "cmd": ["gemini", "--acp"],
     "key_env": "GEMINI_API_KEY", "home_env": "GEMINI_CLI_HOME", "key_required": True,
     "login": None, "install": "npm i -g @google/gemini-cli",
     "env": {"GEMINI_CLI_NO_RELAUNCH": "true"}},
)

_ALLOW = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR",
          "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
          "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"}
_ALLOW_PREFIX = ("LC_", "XDG_")
_FALLBACK_DIRS = ("~/.local/bin", "~/.opencode/bin", "~/.npm-global/bin")

ACCOUNTS_FILE = os.path.expanduser("~/.mystical/agent-accounts.json")
OPTIONS_FILE = os.path.expanduser("~/.mystical/acp-options.json")
HOMES = os.path.expanduser("~/.mystical/agent-homes")
_lock = threading.Lock()
_options: dict = {}

_CLAUDE_TOKENS = {"claude", "anthropic", "opus", "sonnet", "haiku", "fable"}


def preset(agent_id) -> "dict | None":
    return next((p for p in PRESETS if p["id"] == agent_id), None)


def _resolve(name: str) -> "str | None":
    """A launcher's absolute path without trusting the ambient PATH (systemd
    gives a short one): PATH, then known install dirs, then the newest nvm node."""
    found = shutil.which(name)
    if found:
        return found
    for d in _FALLBACK_DIRS:
        cand = os.path.join(os.path.expanduser(d), name)
        if os.access(cand, os.X_OK):
            return cand
    nvm = sorted(glob.glob(os.path.expanduser(f"~/.nvm/versions/node/*/bin/{name}")))
    return nvm[-1] if nvm else None


def argv(p: dict) -> list:
    exe = _resolve(p["cmd"][0])
    return [exe or p["cmd"][0], *p["cmd"][1:]]


def available() -> list:
    return [{k: v for k, v in p.items() if k != "env"} | {"installed": bool(_resolve(p["cmd"][0]))}
            for p in PRESETS]


# --- accounts ---------------------------------------------------------------

def _load() -> list:
    try:
        with open(ACCOUNTS_FILE, encoding="utf-8") as f:
            rows = json.load(f).get("accounts", [])
    except (OSError, ValueError, AttributeError):
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("id")]


def _save(rows: list) -> None:
    os.makedirs(os.path.dirname(ACCOUNTS_FILE), mode=0o700, exist_ok=True)
    tmp = ACCOUNTS_FILE + ".tmp"
    try:
        os.unlink(tmp)                 # a stale tmp may be loose-mode; never write through it
    except FileNotFoundError:
        pass
    # O_EXCL: created here at 0600, never written through something already there.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"accounts": rows}, f, indent=2)
    os.replace(tmp, ACCOUNTS_FILE)


def _mask(a: dict) -> dict:
    out = {k: v for k, v in a.items() if k != "key"}
    if a.get("key"):
        k = a["key"]
        out["key"] = (k[:3] + "…" + k[-4:]) if len(k) > 10 else "…"
    return out


def accounts(agent: "str | None" = None) -> list:
    return [_mask(a) for a in _load() if agent is None or a["agent"] == agent]


def account(acct_id) -> "dict | None":
    return next((a for a in _load() if a["id"] == acct_id), None) if acct_id else None


def home_dir(acct_id: str) -> str:
    return os.path.join(HOMES, acct_id)


def _ensure_home(acct_id: str) -> str:
    """A separate login's 0700 dir. HOMES itself must be made 0700 too: makedirs
    only applies `mode` to the leaf, so a first call with just the leaf path
    leaves HOMES (an intermediate dir) at the OS default."""
    os.makedirs(HOMES, mode=0o700, exist_ok=True)
    d = home_dir(acct_id)
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def add_account(agent: str, label: str, kind: str, key: "str | None" = None) -> dict:
    p = preset(agent)
    label = (label or "").strip()[:32]
    if p is None:
        raise ValueError(f"unknown agent {agent!r}")
    if not label:
        raise ValueError("label is required")
    if kind == "key":
        if not p["key_env"]:
            raise ValueError(f"{p['label']} takes no API key here; use a separate login")
        key = (key or "").strip()
        if not key:
            raise ValueError("key is required")
    elif kind == "home":
        if not p["home_env"] or p["key_required"]:
            raise ValueError(f"{p['label']} can't use a separate login here")
        key = None
    else:
        raise ValueError("kind must be key or home")
    a = {"id": "a_" + uuid.uuid4().hex[:8], "agent": agent, "label": label, "kind": kind}
    if key:
        a["key"] = key
    with _lock:
        _save(_load() + [a])
    if kind == "home":
        _ensure_home(a["id"])
    return _mask(a)


def remove_account(acct_id: str) -> None:
    with _lock:
        rows = _load()
        if not any(a["id"] == acct_id for a in rows):
            raise KeyError(acct_id)
        _save([a for a in rows if a["id"] != acct_id])
    # ponytail: a separate login's home dir is left on disk; it holds that
    # CLI's own login, which `rm -r` (or the CLI's logout) is the honest way to end.


# --- environment --------------------------------------------------------------

def env_for(p: dict, acct_id) -> dict:
    env = {k: v for k, v in os.environ.items()
           if k in _ALLOW or k.startswith(_ALLOW_PREFIX)}
    exe = _resolve(p["cmd"][0])
    if exe:   # npx needs node beside it; the systemd PATH may lack the nvm dir
        env["PATH"] = os.path.dirname(exe) + os.pathsep + env.get("PATH", "")
    env.update(p.get("env") or {})
    a = account(acct_id)
    if a and a["agent"] == p["id"]:
        if a["kind"] == "key" and p["key_env"]:
            env[p["key_env"]] = a["key"]
        elif a["kind"] == "home" and p["home_env"]:
            env[p["home_env"]] = _ensure_home(a["id"])
    return env


def login_hint(p: dict, acct_id) -> str:
    if not p.get("login"):
        return f"Add a {p['label']} API key under Settings ▸ Accounts ▸ Agents."
    a = account(acct_id)
    if a and a["kind"] == "home":
        return f"Run once in a terminal: {p['home_env']}={home_dir(a['id'])} {p['login']}"
    return f"Run once in a terminal: {p['login']}"


def is_claude_model(value) -> bool:
    toks = re.split(r"[^a-z0-9]+", str(value or "").lower())
    return any(t in _CLAUDE_TOKENS for t in toks)


def run_problem(p: "dict | None", acct_id, chat_id, model) -> "str | None":
    """Why this agent turn may not start, or None."""
    if p is None:
        return "That agent is no longer offered."
    if chat_id != config.DASH_CHAT_ID:
        return "Agent profiles run only in the bridge owner's chat (one person per login)."
    if model and is_claude_model(model):
        return "Claude models run in a Claude profile, not through another agent."
    if acct_id and (account(acct_id) or {}).get("agent") != p["id"]:
        return f"The {p['label']} account in this profile is gone. Edit the profile."
    if p["key_required"] and not acct_id:
        return f"{p['label']} needs an API key account. {login_hint(p, acct_id)}"
    if not _resolve(p["cmd"][0]):
        return f"{p['label']} isn't installed here. Install: {p['install']}"
    return None


# --- options cache --------------------------------------------------------------

_CATEGORY = {"model": "model", "mode": "mode", "thought_level": "effort"}


def _flat(opts) -> list:
    out = []
    for o in opts or []:
        if isinstance(o, dict) and "options" in o and "value" not in o:
            out += _flat(o["options"])            # a group
        elif isinstance(o, dict) and "value" in o:
            out.append({"value": str(o["value"]), "name": str(o.get("name") or o["value"])})
    return out


def _shape(config_options, modes) -> dict:
    got = {"model": [], "mode": [], "effort": []}
    for o in config_options or []:
        cat = _CATEGORY.get((o or {}).get("category"))
        if cat and o.get("type", "select") == "select":
            got[cat] = _flat(o.get("options"))
    if not got["mode"] and isinstance(modes, dict):
        got["mode"] = [{"value": str(m.get("id")), "name": str(m.get("name") or m.get("id"))}
                       for m in modes.get("availableModes") or [] if isinstance(m, dict)]
    return got


def _key(agent, acct_id) -> str:
    return f"{agent}|{acct_id or ''}"


def _load_options() -> None:
    """Fill the in-memory cache from disk once. Caller holds _lock."""
    if _options:
        return
    try:
        with open(OPTIONS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _options.update(data)
    except (OSError, ValueError):
        pass


def remember_options(agent: str, acct_id, config_options, modes) -> None:
    shaped = _shape(config_options, modes)
    with _lock:
        _load_options()
        _options[_key(agent, acct_id)] = shaped
        os.makedirs(os.path.dirname(OPTIONS_FILE), mode=0o700, exist_ok=True)
        with open(OPTIONS_FILE + ".tmp", "w", encoding="utf-8") as f:
            json.dump(_options, f)
        os.replace(OPTIONS_FILE + ".tmp", OPTIONS_FILE)


def options_for(agent: str, acct_id) -> dict:
    with _lock:
        _load_options()
        return _options.get(_key(agent, acct_id)) or {"model": [], "mode": [], "effort": []}


def api_info() -> dict:
    """GET /local/agents: what the AGENTS section and the profile editor show."""
    with _lock:
        _load_options()
        opts = dict(_options)
    return {"presets": available(), "accounts": accounts(), "options": opts}


def api_account(body: dict) -> "tuple[dict, int]":
    """POST …/accounts: {action: create|delete, agent, label, kind, key?, id?}."""
    action = body.get("action")
    try:
        if action == "create":
            a = add_account(body.get("agent"), body.get("label"), body.get("kind"), body.get("key"))
            # A separate login is empty until its CLI signs in: say how, once.
            hint = {"login_hint": login_hint(preset(a["agent"]), a["id"])} if a["kind"] == "home" else {}
            return {"ok": True, "account": a, **hint}, 200
        if action == "delete":
            remove_account(str(body.get("id") or ""))
            return {"ok": True}, 200
    except KeyError:
        return {"error": "no such account"}, 404
    except ValueError as e:
        return {"error": str(e)}, 400
    return {"error": "action must be create or delete"}, 400


def api_test(body: dict) -> "tuple[dict, int]":
    """POST …/test: {agent, account}. Runs the agent once in a scratch dir
    (bridge/acp.py probe()) and remembers what it offers."""
    from bridge import acp   # local: acp.py imports this module at its own top
    p = preset(body.get("agent"))
    if p is None:
        return {"error": f"unknown agent {body.get('agent')!r}"}, 404
    acct = body.get("account") or None
    res = acp.probe(argv=argv(p), env=env_for(p, acct), label=p["label"],
                    login_hint=login_hint(p, acct))
    if res.get("ok"):
        remember_options(p["id"], acct, res.get("options"), res.get("modes"))
        return {"ok": True, "options": options_for(p["id"], acct)}, 200
    return res, 200
