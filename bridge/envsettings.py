"""Every environment setting that had no switch, as one editable list.

`bridge/aifeatures.py` lifted the model-spending extras out of the environment
and into a tab, because a switch only whoever deployed the bridge can reach is
not a setting anybody has. The rest of `bridge/config.py` was left where it was:
a run's timeout, the permission mode new sessions carry, the dev-server command,
the ports. Same problem, so this is the same answer applied to the remainder —
one table of what is settable, persisted next to the DB, edited from the
dashboard's SYSTEM tab.

Precedence matches aifeatures': the persisted value wins; with none, the
environment (what `config` read at import) decides; with neither, the code
default. The mechanism is deliberately blunt — `apply()` writes straight onto the
`config` module's attributes, and since every consumer in the bridge reads
`config.X` at call time rather than copying it at import, a saved value is live
for the next turn without a restart and without touching those call sites.

Not everything can be live: a port is bound once, the DB is opened once, the
Telegram token is what the poll loop is already authenticated with. Those carry
``live: False`` and say so in the UI — they still persist, they just take effect
on the next start. Nothing here rewrites your .env; that file stays the boot
default this layer sits on top of, so clearing an override always has somewhere
to fall back to.

Stdlib only, one small JSON file, readable by a bridge whose store is
mid-migration.
"""

import json
import os
import threading

from bridge import config

# key    -- the environment variable name; also the id the API and UI use
# attr   -- the bridge.config attribute it sets, when the two differ
# type   -- bool | int | str | text | path | enum | csvint | secret
# live   -- does saving it change behaviour now, or only on the next start?
# group  -- the block it renders under
# hint   -- the one line under its label
# about  -- the paragraph behind the ⓘ
SETTINGS = (
    # --- access -------------------------------------------------------------
    {"key": "TELEGRAM_BOT_TOKEN", "attr": "TOKEN", "type": "secret", "live": False,
     "group": "ACCESS", "label": "BOT TOKEN", "hint": "the @BotFather token this bot runs as",
     "about": "The bridge authenticates its long-poll loop with this at boot, so a "
              "new one only takes effect on the next start. Shown masked and never "
              "returned in full."},
    {"key": "ALLOWED_CHAT_IDS", "type": "csvint", "live": False,
     "group": "ACCESS", "label": "ALLOWED CHAT IDS", "hint": "comma-separated; who may drive this bridge",
     "placeholder": "123456789, 987654321",
     "about": "The Telegram trust boundary: anyone here can run Claude and start dev "
              "servers on this machine. Empty means discovery mode — the bridge "
              "answers but executes nothing. Changing it mid-run would leave the Mini "
              "App menu button pointed at the old set, so it waits for a restart."},
    {"key": "DASH_TOKEN", "type": "secret", "live": False, "allow_empty": True,
     "group": "ACCESS", "label": "DASHBOARD TOKEN", "hint": "anti-CSRF gate on the ?token= link",
     "about": "Any web page can POST to 127.0.0.1, so state-changing dashboard "
              "requests carry this. Saving an empty value DISABLES the gate "
              "(localhost convenience, drops the CSRF defence). Clearing the override "
              "returns to whatever the environment set — with nothing set there, a "
              "fresh random token each start."},
    {"key": "DASH_CHAT_ID", "type": "int", "live": False, "min": 0,
     "group": "ACCESS", "label": "DASHBOARD CHAT ID", "hint": "whose sessions the dashboard acts as",
     "about": "The dashboard has no Telegram identity of its own; its sessions belong "
              "to this chat id. 0 means the lowest allowed chat id, or a "
              "Telegram-free install."},

    # --- projects -----------------------------------------------------------
    {"key": "BASE_PATH", "type": "path", "live": False,
     "group": "PROJECTS", "label": "BASE PATH", "hint": "the folder the project browser starts in",
     "about": "Typically the parent of your repos. The upload directory hangs off it, "
              "and the browser refuses to walk above it, so moving it is a restart: "
              "sessions recorded under the old root would stop resolving."},
    {"key": "DEFAULT_PROJECT", "type": "str", "live": True,
     "group": "PROJECTS", "label": "DEFAULT PROJECT", "hint": "selected until a chat picks one",
     "about": "A path under BASE_PATH that a chat with no project of its own starts "
              "in. Empty means the bridge asks first."},

    # --- runs ---------------------------------------------------------------
    {"key": "RUN_TIMEOUT", "type": "int", "live": True, "min": 60, "max": 86400, "unit": "seconds",
     "group": "RUNS", "label": "RUN TIMEOUT", "hint": "when the watchdog kills a run",
     "about": "Counts time a run spends actually working — seconds blocked on an "
              "Allow/Deny card or an unanswered question don't age it — so a turn "
              "waiting on you is never killed for waiting. A run stopped here is not "
              "a user Stop, so AUTO-RESUME will restart it where it left off."},
    {"key": "AUTO_RESUME", "type": "bool", "live": True,
     "group": "RUNS", "label": "AUTO-RESUME", "hint": "restart a turn that died without you stopping it",
     "about": "Only you may stop a turn. A bridge restart leaves the in-flight turn "
              "'running' and the next boot resumes it; a Claude crash, a 5xx, or a "
              "RUN TIMEOUT kill while the bridge stays up is resumed immediately. "
              "Capped at five consecutive dead turns per session, so one that keeps "
              "dying can't burn tokens forever. Off, every such turn stays stopped "
              "and waits for you."},
    {"key": "CONTEXT_WINDOW", "type": "int", "live": True, "min": 1000, "unit": "tokens",
     "group": "RUNS", "label": "CONTEXT WINDOW", "hint": "denominator for the context meter",
     "about": "The Models API doesn't report per-model windows, so the meter needs one "
              "number. Raise it for 1M-context runs. Display only — it doesn't change "
              "what any model actually accepts."},
    {"key": "NEW_SESSION_PERMISSION_MODE", "type": "enum", "live": True,
     "choices": ("auto", "plan", "acceptEdits", "bypassPermissions", "default"),
     "group": "RUNS", "label": "NEW SESSION MODE", "hint": "permission mode a dashboard/Mini App session is created with",
     "about": "Persisted on the session, so continuing it from any surface keeps the "
              "posture. 'bypassPermissions' is full autonomy: anything that can inject "
              "a prompt then runs commands as you. 'default' surfaces Allow/Deny "
              "cards; 'plan' plans without editing. A per-message pick still overrides "
              "one run."},
    {"key": "MINIAPP_PERMISSION_MODE", "type": "enum", "live": True,
     "choices": ("auto", "plan", "acceptEdits", "bypassPermissions", "default"),
     "group": "RUNS", "label": "FALLBACK MODE", "hint": "used when a run requests no mode of its own",
     "about": "The chat clients normally send a mode per message; this is what a run "
              "that sends none gets. 'auto' lets Claude's own classifier decide."},
    {"key": "EXTRA_CLAUDE_ARGS", "type": "str", "live": True,
     "group": "RUNS", "label": "BOT CLI ARGS", "hint": "flags for the plain-text Telegram path",
     "placeholder": "--permission-mode acceptEdits",
     "about": "Only the bot's `claude -p` path uses these; dashboard and Mini App "
              "sessions take NEW SESSION MODE instead. "
              "'--dangerously-skip-permissions' is full autonomy — set it only with "
              "ALLOWED CHAT IDS locked down."},
    {"key": "CLAUDE_BIN", "type": "str", "live": True,
     "group": "RUNS", "label": "CLAUDE BINARY", "hint": "the launcher, bare name or absolute path",
     "about": "Left as a bare name it resolves on PATH, and the runner also falls back "
              "to the known install dirs so a stripped PATH (systemd, cron, a "
              "non-login shell) can't make it vanish. Set an absolute path to pin one "
              "install."},
    {"key": "MCP_SERVERS", "type": "str", "live": True,
     "group": "RUNS", "label": "MCP SEED", "hint": "servers a new session starts with, comma-separated",
     "placeholder": "playwright,chrome-devtools",
     "about": "By `claude mcp list` name. The rest start denied so their tool schemas "
              "stay out of the window — every server on this machine costs more "
              "schema than a 200k window holds, which kills a session before it reads "
              "anything. A seed only: the Tools modal's SAVE AS DEFAULT outranks it."},
    {"key": "ASK_SYSTEM_PROMPT", "type": "text", "live": True, "allow_empty": True,
     "group": "RUNS", "label": "SYSTEM PROMPT", "hint": "appended to every run's system prompt",
     "about": "What makes a run answer like something reporting to a phone: outcome "
              "first, never claim something passes without running it, and stop on a "
              "card rather than guess. Empty disables the append entirely."},
    {"key": "NOTIFY_ENABLE", "type": "bool", "live": True,
     "group": "RUNS", "label": "PUSH ON FINISH", "hint": "ping Telegram when a panel run needs you or ends",
     "about": "Lets you walk away from the dashboard or Mini App and still get told. "
              "The bot's own plain-text turns are never notified — they already reply "
              "in the chat."},

    # --- dev server ---------------------------------------------------------
    {"key": "START_CMD", "type": "str", "live": True,
     "group": "DEV SERVER", "label": "START COMMAND", "hint": "default command for /server",
     "placeholder": "npm run dev",
     "about": "The fallback for a repo whose own command hasn't been detected or set. "
              "Per-project commands are stored with the project and win over this."},
    {"key": "PREVIEW_PORT", "type": "int", "live": True, "min": 1, "max": 65535,
     "group": "DEV SERVER", "label": "DEV PORT", "hint": "port the preview link assumes",
     "about": "Where the dev server is expected to listen when a project doesn't say "
              "otherwise."},
    {"key": "CLOUDFLARED_BIN", "type": "str", "live": True,
     "group": "DEV SERVER", "label": "TUNNEL BINARY", "hint": "the tunnel client executable",
     "about": "Bare name resolves on PATH. Set an absolute path if it lives somewhere "
              "a non-login shell won't find."},

    # --- uploads ------------------------------------------------------------
    {"key": "UPLOAD_MAX_MB", "type": "int", "live": True, "min": 1, "max": 512, "unit": "MB",
     "group": "UPLOADS", "label": "MAX SIZE", "hint": "per screenshot",
     "about": "A single attachment larger than this is refused before it is written."},
    {"key": "UPLOAD_MAX_COUNT", "type": "int", "live": True, "min": 1, "max": 100,
     "group": "UPLOADS", "label": "MAX PER MESSAGE", "hint": "attachments one prompt may carry",
     "about": "How many images a single prompt may bring."},
    {"key": "UPLOAD_KEEP_DAYS", "type": "int", "live": True, "min": 1, "max": 3650, "unit": "days",
     "group": "UPLOADS", "label": "KEEP FOR", "hint": "before a finished run's images are pruned",
     "about": "Screenshots outlive their run so the transcript can still show them. "
              "Each run's end prunes directories older than this."},

    # --- AI tuning ----------------------------------------------------------
    {"key": "RELEVANCE_MODEL", "type": "str", "live": True,
     "group": "AI TUNING", "label": "GUARD MODEL", "hint": "model for the new-session guard",
     "about": "Only consulted while the AI tab's NEW-SESSION GUARD is on."},
    {"key": "RELEVANCE_MIN_CHARS", "type": "int", "live": True, "min": 1, "unit": "chars",
     "group": "AI TUNING", "label": "GUARD MIN LENGTH", "hint": "shorter prompts are never checked",
     "about": "Short follow-ups never pay for a check. Raise it to check less."},
    {"key": "RELEVANCE_CONTEXT_TURNS", "type": "int", "live": True, "min": 1, "max": 50,
     "group": "AI TUNING", "label": "GUARD CONTEXT", "hint": "turns of history the check reads",
     "about": "How much of the session the guard sees before judging whether a prompt "
              "continues it."},
    {"key": "RELEVANCE_TIMEOUT", "type": "int", "live": True, "min": 1, "unit": "seconds",
     "group": "AI TUNING", "label": "GUARD TIMEOUT", "hint": "before the check fails open",
     "about": "Measured 8-15s per check including CLI cold start, so this is "
              "deliberately generous — at a tighter timeout every check fails open and "
              "the guard is a silent no-op. A failure always lets the prompt through."},
    {"key": "NEXTUP_MODEL", "type": "str", "live": True,
     "group": "AI TUNING", "label": "SCOUT MODEL", "hint": "model for the next-up board's Claude rung",
     "about": "Used only after the free-agent rung is unavailable, and only while the "
              "AI tab's NEXT-UP BOARD is on."},
    {"key": "NEXTUP_DAYS", "type": "int", "live": True, "min": 1, "max": 365, "unit": "days",
     "group": "AI TUNING", "label": "SCOUT WINDOW", "hint": "how far back activity counts",
     "about": "Repos with no session activity inside this window aren't scouted."},
    {"key": "NEXTUP_MAX_REPOS", "type": "int", "live": True, "min": 1, "max": 50,
     "group": "AI TUNING", "label": "SCOUT CEILING", "hint": "repos scouted per refresh",
     "about": "The hard cost ceiling on one board refresh. Only a repo whose git state "
              "moved is re-scouted at all."},
    {"key": "NEXTUP_SCOUT_TIMEOUT", "type": "int", "live": True, "min": 1, "unit": "seconds",
     "group": "AI TUNING", "label": "SCOUT TIMEOUT", "hint": "per repo",
     "about": "A scout that overruns is dropped and its repo simply contributes "
              "nothing to the board."},

    # --- servers ------------------------------------------------------------
    {"key": "MINIAPP_ENABLE", "type": "bool", "live": False,
     "group": "SERVERS", "label": "MINI APP", "hint": "the Telegram panel and its tunnel",
     "about": "Off, no tunnel client is required at all. The panel's HTTP server and "
              "its tunnel are started once at boot, so this waits for a restart."},
    {"key": "MINIAPP_PORT", "type": "int", "live": False, "min": 1, "max": 65535,
     "group": "SERVERS", "label": "MINI APP PORT", "hint": "local bind port behind the tunnel",
     "about": "Bound once at boot."},
    {"key": "DASH_ENABLE", "type": "bool", "live": False,
     "group": "SERVERS", "label": "DASHBOARD", "hint": "this dashboard, on localhost",
     "about": "Switching this off and restarting takes away the surface you are "
              "reading — you would set it back in .env."},
    {"key": "DASH_PORT", "type": "int", "live": False, "min": 1, "max": 65535,
     "group": "SERVERS", "label": "DASHBOARD PORT", "hint": "127.0.0.1 only, never tunneled",
     "about": "Bound once at boot. The dashboard is localhost-only by design; the host "
              "is not settable."},
    {"key": "LANDING_PORT", "type": "int", "live": False, "min": 1, "max": 65535,
     "group": "SERVERS", "label": "LANDING PORT", "hint": "the marketing page, locally",
     "about": "Serves site/dist so the landing page can be looked at without "
              "deploying. Bound once at boot."},
    {"key": "BRIDGE_DB", "type": "path", "live": False,
     "group": "SERVERS", "label": "SESSION STORE", "hint": "SQLite file behind every conversation",
     "about": "The source of truth for sessions, turns and events, kept in $HOME "
              "outside the repo at mode 600. Opened once at boot; pointing it "
              "elsewhere starts an empty history."},

    # --- tunnel -------------------------------------------------------------
    {"key": "PREVIEW_HOSTNAME", "type": "str", "live": False,
     "group": "TUNNEL", "label": "PANEL HOSTNAME", "hint": "stable URL for the Mini App panel",
     "about": "The name is historical — it fronts the panel, not /preview. Unset, the "
              "panel falls back to a throwaway quick tunnel whose hostname changes "
              "every restart, breaking every panel link already sent to Telegram."},
    {"key": "TUNNEL_NAME", "type": "str", "live": False,
     "group": "TUNNEL", "label": "TUNNEL NAME", "hint": "the named tunnel to run",
     "about": "Provisioned once with the provider's API, together with its DNS record."},
    {"key": "TUNNEL_ID", "type": "str", "live": False,
     "group": "TUNNEL", "label": "TUNNEL ID", "hint": "its uuid",
     "about": "Returned when the tunnel is created."},
    {"key": "TUNNEL_CREDENTIALS_FILE", "type": "path", "live": False,
     "group": "TUNNEL", "label": "CREDENTIALS FILE", "hint": "lets the client run it locally",
     "about": "Git-ignored, in $HOME. Without it the named tunnel can't be run and the "
              "panel falls back to a quick tunnel."},
    {"key": "TUNNEL_CONFIG_FILE", "type": "path", "live": False,
     "group": "TUNNEL", "label": "CONFIG FILE", "hint": "optional client config",
     "about": "Passed to the tunnel client when set."},
)

_BY_KEY = {s["key"]: s for s in SETTINGS}
_lock = threading.Lock()
_cache: "dict | None" = None

# What `config` held before anything here touched it: the environment's answer,
# or the code default. Clearing an override falls back to this, so .env stays the
# floor under every saved value. Captured at import, before the first apply().
_BASE = {s["key"]: getattr(config, s.get("attr", s["key"]), None) for s in SETTINGS}
# Was it the environment that said so, or the code default? config collapses the
# two, so the distinction has to be read from os.environ while it still means
# what it meant at boot.
_FROM_ENV = {s["key"]: s["key"] in os.environ for s in SETTINGS}


def _path() -> str:
    """Beside the DB — but the DB the *environment* named, not the live one. This
    file is what makes BRIDGE_DB overridable, so following its own override would
    move it out from under itself and lose every setting on the next boot."""
    return os.path.join(os.path.dirname(_BASE["BRIDGE_DB"] or "") or ".",
                        "env_settings.json")


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            with open(_path()) as f:
                raw = json.load(f)
            _cache = {k: v for k, v in (raw or {}).items() if k in _BY_KEY}
        except (OSError, ValueError, AttributeError):
            _cache = {}
    return _cache


def _truthy(v) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() not in ("0", "false", "no", "")


def coerce(spec: dict, raw):
    """The stored JSON value as the type `config` holds. Raises ValueError."""
    kind = spec["type"]
    if kind == "bool":
        return _truthy(raw)
    if kind == "int":
        try:
            n = int(str(raw).strip())
        except (TypeError, ValueError):
            raise ValueError(f"{spec['key']} must be a whole number")
        if "min" in spec and n < spec["min"]:
            raise ValueError(f"{spec['key']} must be at least {spec['min']}")
        if "max" in spec and n > spec["max"]:
            raise ValueError(f"{spec['key']} must be at most {spec['max']}")
        return n
    if kind == "enum":
        s = str(raw).strip()
        if s not in spec["choices"]:
            raise ValueError(f"{spec['key']} must be one of {', '.join(spec['choices'])}")
        return s
    if kind == "path":
        return os.path.expanduser(str(raw).strip())
    if kind == "csvint":
        try:
            return {int(x) for x in str(raw).replace(" ", "").split(",") if x}
        except ValueError:
            raise ValueError(f"{spec['key']} must be comma-separated numbers")
    return str(raw)                      # str | text | secret


def _derive() -> None:
    """Values config computes from another setting, recomputed after a change so
    an override can't leave the pair disagreeing."""
    config.API = f"https://api.telegram.org/bot{config.TOKEN}"
    config.UPLOAD_DIR = os.path.join(config.BASE_PATH, ".bridge_uploads")


def apply() -> None:
    """Write every saved override onto `config`, and every unsaved one back to
    what the environment said. Consumers read `config.X` per call, so this is the
    whole mechanism — call it at boot and after any change."""
    with _lock:
        saved = dict(_load())
    for spec in SETTINGS:
        key, attr = spec["key"], spec.get("attr", spec["key"])
        value = _BASE[key]
        if key in saved:
            try:
                value = coerce(spec, saved[key])
            except ValueError:
                pass                     # a corrupt entry falls back, never crashes boot
        setattr(config, attr, value)
    _derive()


def get(key: str):
    """The effective value of one setting."""
    spec = _BY_KEY[key]
    return getattr(config, spec.get("attr", key), None)


def set_value(key: str, raw) -> None:
    """Save an override; None clears it back to the environment's answer."""
    spec = _BY_KEY.get(key)
    if spec is None:
        raise ValueError(f"unknown setting {key!r}")
    if raw is not None:
        if not str(raw).strip() and not spec.get("allow_empty") and spec["type"] != "str":
            raise ValueError(f"{key} cannot be empty")
        coerce(spec, raw)                # validate before persisting
    global _cache
    with _lock:
        cur = dict(_load())
        if raw is None:
            cur.pop(key, None)
        else:
            cur[key] = raw if isinstance(raw, (bool, int)) else str(raw)
        _cache = cur
        try:
            os.makedirs(os.path.dirname(_path()), exist_ok=True)
            with open(_path(), "w") as f:
                json.dump(cur, f, indent=1)
            os.chmod(_path(), 0o600)     # it can hold the bot token
        except OSError:
            pass                         # the in-memory value still holds for this process
    apply()


def _shown(spec: dict, value):
    """What the UI may see. A secret is never returned in full."""
    if spec["type"] == "secret":
        s = str(value or "")
        return f"…{s[-4:]}" if len(s) > 4 else ("set" if s else "")
    if spec["type"] == "csvint":
        return ", ".join(str(n) for n in sorted(value or ()))
    if spec["type"] == "bool":
        return bool(value)
    return value


def state() -> list[dict]:
    """Every setting with its current answer and where that answer came from."""
    with _lock:
        saved = _load()
    out = []
    for spec in SETTINGS:
        key = spec["key"]
        value = get(key)
        out.append({
            "key": key,
            "label": spec["label"],
            "group": spec["group"],
            "type": spec["type"],
            "live": spec["live"],
            "hint": spec["hint"],
            "about": spec["about"],
            "value": _shown(spec, value),
            "source": "saved" if key in saved else ("env" if _FROM_ENV[key] else "default"),
            "default": _shown(spec, _BASE[key]),
            **({"choices": list(spec["choices"])} if "choices" in spec else {}),
            **({"unit": spec["unit"]} if "unit" in spec else {}),
            **({"placeholder": spec["placeholder"]} if "placeholder" in spec else {}),
        })
    return out
