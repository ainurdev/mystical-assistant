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

# Permission posture for `claude -p`. See SECURITY notes.
#   --permission-mode acceptEdits     (default) edits files, limited
#   --dangerously-skip-permissions    full autonomy incl. running commands
EXTRA_CLAUDE_ARGS = os.environ.get("EXTRA_CLAUDE_ARGS", "--permission-mode acceptEdits")

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
