"""Configuration (override via environment variables). See SECURITY notes in README."""

import os

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

# Permission mode for the interactive Mini App chat. "default" makes Claude ask
# before permissioned tools, surfacing Allow/Deny cards in the chat (the
# stream-json control protocol). Use "acceptEdits"/"bypassPermissions" to ask less.
MINIAPP_PERMISSION_MODE = os.environ.get("MINIAPP_PERMISSION_MODE", "default")

# Appended to Claude's system prompt so it asks instead of guessing. Set empty
# to disable.
ASK_SYSTEM_PROMPT = os.environ.get("ASK_SYSTEM_PROMPT", (
    "You are operating through a Telegram bridge with a human who can reply. "
    "If a task is ambiguous, or you need a decision, a credential, or "
    "confirmation before doing something irreversible, STOP and ask exactly one "
    "concise question rather than guessing. Otherwise finish the task and report "
    "the result briefly."))

RUN_TIMEOUT = int(os.environ.get("RUN_TIMEOUT", "1800"))      # per Claude run (s)
PREVIEW_PORT = int(os.environ.get("PREVIEW_PORT", "3000"))    # default dev port
START_CMD = os.environ.get("START_CMD", "npm run dev")        # default /server cmd
CLOUDFLARED_BIN = os.environ.get("CLOUDFLARED_BIN", "cloudflared")

# --- Named preview tunnel ----------------------------------------------------
# /preview runs a *named* Cloudflare Tunnel so the public URL is stable
# (https://PREVIEW_HOSTNAME) instead of a random *.trycloudflare.com link. The
# tunnel + DNS are provisioned once via the Cloudflare API; the credentials file
# (git-ignored, in $HOME) lets cloudflared run it locally. The Mini App control
# panel still uses an ephemeral quick tunnel (see tunnel.open_quick_tunnel).
PREVIEW_HOSTNAME = os.environ.get("PREVIEW_HOSTNAME", "preview.mhzrerfani.dev")
TUNNEL_NAME = os.environ.get("TUNNEL_NAME", "mystical-preview")
TUNNEL_ID = os.environ.get("TUNNEL_ID", "612b1ee2-693c-4640-a3ed-133adce0da6b")
TUNNEL_CREDENTIALS_FILE = os.path.expanduser(os.environ.get(
    "TUNNEL_CREDENTIALS_FILE", "~/.cloudflared/mystical-preview.json"))
TUNNEL_CONFIG_FILE = os.path.expanduser(os.environ.get(
    "TUNNEL_CONFIG_FILE", "~/.cloudflared/mystical-preview-config.yml"))

POLL_TIMEOUT = 30
API = f"https://api.telegram.org/bot{TOKEN}"
TG_MAX = 4000
MAX_BTNS = 40                     # folder buttons per browser screen
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv",
             "dist", "build", ".next", "target", ".cache"}

# --- Mini App ----------------------------------------------------------------
MINIAPP_ENABLE = os.environ.get("MINIAPP_ENABLE", "1").lower() not in ("0", "false", "no", "")
MINIAPP_PORT = int(os.environ.get("MINIAPP_PORT", "8787"))   # local HTTP bind port
UPLOAD_MAX_MB = int(os.environ.get("UPLOAD_MAX_MB", "10"))   # per screenshot
UPLOAD_MAX_COUNT = int(os.environ.get("UPLOAD_MAX_COUNT", "8"))
UPLOAD_DIR = os.path.join(BASE_PATH, ".bridge_uploads")
