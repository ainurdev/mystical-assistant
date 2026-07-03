"""Configuration (override via environment variables). See SECURITY notes in README."""

import os
import secrets

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")

# Root folder the project browser starts in. Typically the parent of your
# orgs/repos, e.g. ~/code  (with ~/code/<org>/<repo> underneath).
BASE_PATH = os.path.realpath(os.path.expanduser(
    os.environ.get("BASE_PATH", os.getcwd())))

# Optional project selected by default until one is chosen via /projects.
DEFAULT_PROJECT = os.environ.get("DEFAULT_PROJECT", "") or None

ALLOWED_CHAT_IDS = {
    int(x) for x in os.environ.get("ALLOWED_CHAT_IDS", "").replace(" ", "").split(",") if x
}

# Permission posture for the bot's plain-text path (`claude -p`). See SECURITY notes.
#   --permission-mode acceptEdits     (default) edits files, limited
#   --dangerously-skip-permissions    full autonomy incl. running commands
EXTRA_CLAUDE_ARGS = os.environ.get("EXTRA_CLAUDE_ARGS", "--permission-mode acceptEdits")

# Default permission ("operating") mode for the interactive chat clients when a
# run doesn't request one. Clients pick per-chat from MINIAPP_PERMISSION_MODES.
# "bypassPermissions" runs fully autonomously (never asks); "default" makes Claude
# ask before permissioned tools, surfacing Allow/Deny cards (stream-json control
# protocol); "auto" lets Claude's classifier decide; "plan" plans without editing.
MINIAPP_PERMISSION_MODE = os.environ.get("MINIAPP_PERMISSION_MODE", "auto")

# Model/effort the Mini App chat may request per message (passed as `claude
# --model`/`--effort`). The frontend pickers must stay within these; the server
# rejects an unknown model and drops an unknown effort.
MINIAPP_MODELS = {"opus", "sonnet", "haiku"}
MINIAPP_EFFORTS = {"low", "medium", "high", "xhigh", "max"}
# Permission/operating modes the chat clients may request per message (passed as
# `claude --permission-mode`); the server rejects anything outside this set.
MINIAPP_PERMISSION_MODES = {"auto", "plan", "acceptEdits", "bypassPermissions", "default"}

# Sessions started from the desktop dashboard or the Mini App are created with
# this permission mode, persisted on the session, so continuing them from any
# surface stays fully autonomous (no Allow/Deny prompts). A per-message pick can
# still override a single run. The bot path is unaffected (it uses
# EXTRA_CLAUDE_ARGS). See the cross-surface-session-continuity design.
NEW_SESSION_PERMISSION_MODE = os.environ.get("NEW_SESSION_PERMISSION_MODE", "bypassPermissions")

# Appended to Claude's system prompt so it asks instead of guessing. Set empty
# to disable.
ASK_SYSTEM_PROMPT = os.environ.get("ASK_SYSTEM_PROMPT", (
    "You are operating through a Telegram bridge with a human who can reply. "
    "If a task is ambiguous, or you need a decision, a credential, or "
    "confirmation before doing something irreversible, STOP and ask exactly one "
    "concise question rather than guessing. Otherwise finish the task and report "
    "the result briefly."))

RUN_TIMEOUT = int(os.environ.get("RUN_TIMEOUT", "1800"))      # per Claude run (s)

# --- Project memory ----------------------------------------------------------
# Curated, project+branch-scoped memory injected into every turn's system prompt
# and captured (with a Keep/Skip gate) after edits. See the project-memory design.
MEMORY_ENABLE = os.environ.get("MEMORY_ENABLE", "1").lower() not in ("0", "false", "no", "")
MEMORY_TOKEN_BUDGET = int(os.environ.get("MEMORY_TOKEN_BUDGET", "800"))  # resident pack cap

# Push a Telegram message when a streaming (Mini App / dashboard) run needs your
# input or finishes, so you can walk away from the panel and still get pinged.
# The bot's own plain-text turns aren't notified (they already reply in-chat).
NOTIFY_ENABLE = os.environ.get("NOTIFY_ENABLE", "1").lower() not in ("0", "false", "no", "")
PREVIEW_PORT = int(os.environ.get("PREVIEW_PORT", "3000"))    # default dev port
START_CMD = os.environ.get("START_CMD", "npm run dev")        # default /server cmd
CLOUDFLARED_BIN = os.environ.get("CLOUDFLARED_BIN", "cloudflared")

# --- Named preview tunnel ----------------------------------------------------
# /preview runs a *named* Cloudflare Tunnel so the public URL is stable
# (https://PREVIEW_HOSTNAME) instead of a random *.trycloudflare.com link. The
# tunnel + DNS are provisioned once via the Cloudflare API; the credentials file
# (git-ignored, in $HOME) lets cloudflared run it locally. The Mini App control
# panel still uses an ephemeral quick tunnel (see tunnel.open_quick_tunnel).
PREVIEW_HOSTNAME = os.environ.get("PREVIEW_HOSTNAME", "")
TUNNEL_NAME = os.environ.get("TUNNEL_NAME", "")
TUNNEL_ID = os.environ.get("TUNNEL_ID", "")
TUNNEL_CREDENTIALS_FILE = os.path.expanduser(os.environ.get("TUNNEL_CREDENTIALS_FILE", ""))
TUNNEL_CONFIG_FILE = os.path.expanduser(os.environ.get("TUNNEL_CONFIG_FILE", ""))

POLL_TIMEOUT = 30
API = f"https://api.telegram.org/bot{TOKEN}"
TG_MAX = 4000
MAX_BTNS = 40                     # folder buttons per browser screen
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv",
             "dist", "build", ".next", "target", ".cache"}

# --- Mini App ----------------------------------------------------------------
MINIAPP_ENABLE = os.environ.get("MINIAPP_ENABLE", "1").lower() not in ("0", "false", "no", "")
MINIAPP_PORT = int(os.environ.get("MINIAPP_PORT", "8787"))   # local HTTP bind port

# Teacher mode: auto-suggest review candidates after code turns. Default on.
LEARNING_ENABLE = os.environ.get("LEARNING_ENABLE", "1").lower() \
    not in ("0", "false", "no", "")
# Auto-title new sessions with an LLM-generated subject after the first turn
# (Claude-app style), replacing the first-prompt placeholder. Default on.
TITLE_ENABLE = os.environ.get("TITLE_ENABLE", "1").lower() \
    not in ("0", "false", "no", "")
UPLOAD_MAX_MB = int(os.environ.get("UPLOAD_MAX_MB", "10"))   # per screenshot
UPLOAD_MAX_COUNT = int(os.environ.get("UPLOAD_MAX_COUNT", "8"))
UPLOAD_DIR = os.path.join(BASE_PATH, ".bridge_uploads")

# --- Session store -----------------------------------------------------------
# SQLite source of truth for conversations (sessions/turns/events). Lives in
# $HOME (outside the repo), git-ignored, mode 600.
BRIDGE_DB = os.path.expanduser(os.environ.get("BRIDGE_DB", "~/.bridge_state/bridge.db"))

# --- Desktop dashboard (localhost-only, NEVER tunneled) ----------------------
# A second HTTP server bound to 127.0.0.1 that is a full-parity Claude client +
# live log viewer. Because any web page can POST to 127.0.0.1, requests are gated
# on a Host allow-list (anti DNS-rebinding) and state-changing requests require
# DASH_TOKEN (anti CSRF). The dashboard acts as DASH_CHAT_ID's sessions.
DASH_ENABLE = os.environ.get("DASH_ENABLE", "1").lower() not in ("0", "false", "no", "")
DASH_HOST = "127.0.0.1"
DASH_PORT = int(os.environ.get("DASH_PORT", "8790"))
# Unset → a fresh random token per run (secure default). Set DASH_TOKEN="" to
# DISABLE the gate so the dashboard opens with no ?token= (localhost-only
# convenience; drops the CSRF defense — see the SECURITY note above).
_dash_token = os.environ.get("DASH_TOKEN")
DASH_TOKEN = secrets.token_urlsafe(24) if _dash_token is None else _dash_token
DASH_CHAT_ID = int(os.environ.get("DASH_CHAT_ID", "0")) or (
    min(ALLOWED_CHAT_IDS) if ALLOWED_CHAT_IDS else 0)
