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
# --model`/`--effort`). The live model list now comes from the Anthropic Models
# API (see bridge/models.py) and is served to both frontends via the state
# endpoints; MINIAPP_MODELS is only the fallback used when that API/token is
# unavailable. Efforts stay hardcoded frontend-side; an unknown one drops.
MINIAPP_MODELS = ("opus", "sonnet", "haiku", "fable")
MINIAPP_EFFORTS = {"low", "medium", "high", "xhigh", "max"}
# Permission/operating modes the chat clients may request per message (passed as
# `claude --permission-mode`); the server rejects anything outside this set.
# These are exactly the CLI's own choices, canonical spelling: it also accepts
# "manual", but that is only an alias for "default" (normalizePermissionModeAlias),
# so storing it would give one posture two names on the session row.
MINIAPP_PERMISSION_MODES = {"auto", "plan", "acceptEdits", "bypassPermissions",
                            "dontAsk", "default"}

# Sessions started from the desktop dashboard or the Mini App are created with
# this permission mode, persisted on the session, so continuing them from any
# surface stays fully autonomous (no Allow/Deny prompts). A per-message pick can
# still override a single run. The bot path is unaffected (it uses
# EXTRA_CLAUDE_ARGS). See the cross-surface-session-continuity design.
NEW_SESSION_PERMISSION_MODE = os.environ.get("NEW_SESSION_PERMISSION_MODE", "bypassPermissions")

# Appended to Claude's system prompt so it asks instead of guessing. Set empty
# to disable.
ASK_SYSTEM_PROMPT = os.environ.get("ASK_SYSTEM_PROMPT", (
    "You are operating through a Telegram bridge with a human who is usually on "
    "a phone, away from the keyboard. Lead with what is true now rather than "
    "what you did: the outcome first, then the evidence for it — the command you "
    "ran and its result, or the file:line to look at — then the one thing that "
    "needs them. Never report something as passing, working or fixed unless you "
    "ran it; say it is unverified instead. If a task is ambiguous, or you need a "
    "decision, a credential, or confirmation before doing something "
    "irreversible, STOP and ask rather than guessing, and ask with "
    "AskUserQuestion so the choice arrives as a card to tap instead of prose to "
    "type a reply to. One decision, not an interrogation."))

RUN_TIMEOUT = int(os.environ.get("RUN_TIMEOUT", "1800"))      # per Claude run (s)

# Denominator for the context meter: how big the window a session is filling is.
# The Models API doesn't report per-model windows and 1M-context runs are the
# exception, so one overridable number is the whole mechanism.
CONTEXT_WINDOW = int(os.environ.get("CONTEXT_WINDOW", "200000"))

# MCP servers a *new* session starts with, comma-separated, by their
# `claude mcp list` name (e.g. "playwright,chrome-devtools"). The rest start
# denied by name, so their tool schemas stay out of the context window: all
# servers on costs ~263k tokens of schemas against a 200k window, which kills a
# session with "Prompt is too long" before it reads anything.
#
# Only a seed. The Tools modal owns this — switching a server on there wins, and
# SAVE AS DEFAULT stores a new default (bridge/store.py) that this no longer
# overrides. Empty = every server denied by default.
MCP_SERVERS = os.environ.get("MCP_SERVERS", "")

# Auto-resume: only the user may stop a turn. A restart leaves the in-flight turn
# 'running' and the next boot resumes it (bridge/recovery.py); a Claude crash — or a
# RUN_TIMEOUT kill — while the bridge stays up is resumed immediately
# (runner._maybe_auto_resume, capped per session so a session that keeps dying or
# keeps timing out can't burn tokens forever).
AUTO_RESUME = os.environ.get("AUTO_RESUME", "1").lower() not in ("0", "false", "no", "")

# Fallback ladder: what a usage-limit death does beyond waiting for the reset.
#   ask  — offer the available rungs (another Claude account, a free agent) and
#          let the user pick; the session stays parked behind the card
#   auto — take the best rung immediately and report which one
#   wait — park only, the behaviour before the ladder existed
# Per-session overrides live in sessions.fallback_policy; see bridge/ladder.py.
FALLBACK_POLICY = os.environ.get("FALLBACK_POLICY", "ask").strip().lower()

# Push a Telegram message when a streaming (Mini App / dashboard) run needs your
# input or finishes, so you can walk away from the panel and still get pinged.
# The bot's own plain-text turns aren't notified (they already reply in-chat).
NOTIFY_ENABLE = os.environ.get("NOTIFY_ENABLE", "1").lower() not in ("0", "false", "no", "")
PREVIEW_PORT = int(os.environ.get("PREVIEW_PORT", "3000"))    # default dev port
START_CMD = os.environ.get("START_CMD", "npm run dev")        # default /server cmd
CLOUDFLARED_BIN = os.environ.get("CLOUDFLARED_BIN", "cloudflared")
# The `claude` launcher. Left as a bare name so it resolves on PATH; the runner
# additionally falls back to known install dirs so a stripped PATH (systemd,
# cron, a non-login shell) can't make it vanish. Set to an absolute path to pin.
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")

# --- Named tunnel ------------------------------------------------------------
# The Mini App panel runs behind a *named* tunnel so its URL is stable
# (https://PREVIEW_HOSTNAME — the name is historical, it fronts the panel)
# instead of a random throwaway hostname that would break every panel link
# already sent to Telegram on each restart. The tunnel + DNS are provisioned once
# with the provider's API; the credentials file (git-ignored, in $HOME) lets the
# client run it locally. Unset -> the panel falls back to a quick tunnel.
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

# The settings below all buy a model call nobody asked for, so they default OFF
# and are switched on per install from the dashboard's AI tab
# (bridge/aifeatures.py owns that precedence — a persisted switch beats the
# setting here).
# Auto-title new sessions with an LLM-generated subject after the first turn
# (Claude-app style), replacing the first-prompt placeholder.
TITLE_ENABLE = os.environ.get("TITLE_ENABLE", "0").lower() \
    not in ("0", "false", "no", "")
# Context-aware "start a new session?" guardrail: before a substantial prompt
# resumes a session that already has history, a cheap one-shot decides whether it
# belongs there. Unrelated → the prompt is held and the user picks.
RELEVANCE_CHECK = os.environ.get("RELEVANCE_CHECK", "0").lower() \
    not in ("0", "false", "no", "")
RELEVANCE_MODEL = os.environ.get("RELEVANCE_MODEL", "haiku")
RELEVANCE_MIN_CHARS = int(os.environ.get("RELEVANCE_MIN_CHARS", "280"))
RELEVANCE_CONTEXT_TURNS = int(os.environ.get("RELEVANCE_CONTEXT_TURNS", "3"))
# Measured 8-15s per check (haiku, incl. CLI cold start) — not the ~2-4s the design
# doc guessed. At a tighter timeout every check fails open and the guardrail is a
# silent no-op, so this is deliberately generous; it only runs on long prompts.
RELEVANCE_TIMEOUT = int(os.environ.get("RELEVANCE_TIMEOUT", "25"))
# --- Next-up board -----------------------------------------------------------
# Ranked next steps across the repos with recent session activity. One read-only
# scout per changed repo, free-agent rung first. See the next-up-board design.
NEXTUP_ENABLE = os.environ.get("NEXTUP_ENABLE", "0").lower() \
    not in ("0", "false", "no", "")
NEXTUP_DAYS = int(os.environ.get("NEXTUP_DAYS", "7"))        # activity window
NEXTUP_MAX_REPOS = int(os.environ.get("NEXTUP_MAX_REPOS", "6"))  # hard cost ceiling
NEXTUP_SCOUT_TIMEOUT = int(os.environ.get("NEXTUP_SCOUT_TIMEOUT", "120"))
NEXTUP_MODEL = os.environ.get("NEXTUP_MODEL", "haiku")       # Claude fallback path

# --- Lessons -----------------------------------------------------------------
# Write a short lesson about what each finished turn built, into that repo's
# .mystical/learn/. Read (and opted out of, per repo) in the dashboard's LEARN
# tab. Automatic — nobody clicks it — so it defaults OFF.
LEARN_ENABLE = os.environ.get("LEARN_ENABLE", "0").lower() \
    not in ("0", "false", "no", "")

# Decide whether a turn that ENDED on a question is waiting on you or just being
# polite. Free markers (auth failures, usage limits, "reply go") always count;
# this is the fall-through to a model call for the ambiguous rest. Automatic —
# nobody clicks it — so it defaults OFF.
TAIL_STATE_AI = os.environ.get("TAIL_STATE_AI", "0").lower() \
    not in ("0", "false", "no", "")

# --- Run command detection ----------------------------------------------------
# Opening a project's TERMINAL tab, or analysing it, works out how to start its
# dev server. A free heuristic reads the lockfile and scripts first; this decides
# whether a repo the heuristic can't read may fall through to a model call. That
# fall-through is automatic — nobody clicks it — so it defaults OFF.
PREVIEW_DETECT_AI = os.environ.get("PREVIEW_DETECT_AI", "0").lower() \
    not in ("0", "false", "no", "")

# --- Ponytail (code-minimalism level for every run) --------------------------
# Off, the plugin is told `off` for every run (absent would mean its own default,
# full) and its prompt-box cluster and level pickers leave the dashboard.
PONYTAIL_ENABLE = os.environ.get("PONYTAIL_ENABLE", "1").lower() \
    not in ("0", "false", "no", "")

# --- Project map (graphify) ---------------------------------------------------
# The per-project code graph: built after a turn, ~400 tokens of structure in
# every session's system prompt. Off, nothing is built or injected and the MAP
# chip and tab leave the dashboard.
GRAPH_ENABLE = os.environ.get("GRAPH_ENABLE", "1").lower() \
    not in ("0", "false", "no", "")

# --- Generated commit messages -----------------------------------------------
# The GIT tab's "generate" button and the header's SHIP button describe a diff
# with a one-shot haiku call. Unlike the extras above this only runs when you
# press something, so it defaults ON; the switch is here to make the spend
# visible and stoppable.
COMMIT_MSG_AI = os.environ.get("COMMIT_MSG_AI", "1").lower() \
    not in ("0", "false", "no", "")

# --- Claude Design link -------------------------------------------------------
# A repo linked to a Claude Design project can pull that design system down as a
# project skill and push finished components back up. Nothing here fires on its
# own — linking, pulling and syncing are all presses — so it defaults ON, like
# the other press-to-run entries; the switch is there to make an outward-facing
# integration visible and stoppable.
DESIGN_SYNC_ENABLE = os.environ.get("DESIGN_SYNC_ENABLE", "1").lower() \
    not in ("0", "false", "no", "")

UPLOAD_MAX_MB = int(os.environ.get("UPLOAD_MAX_MB", "10"))   # per screenshot
UPLOAD_MAX_COUNT = int(os.environ.get("UPLOAD_MAX_COUNT", "8"))
UPLOAD_DIR = os.path.join(BASE_PATH, ".bridge_uploads")
# A finished run's screenshots stay on disk so the transcript can still show them
# (dashboard GET /local/attachment); each run's end prunes dirs older than this.
UPLOAD_KEEP_DAYS = int(os.environ.get("UPLOAD_KEEP_DAYS", "7"))

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

# --- Landing page (localhost-only) -------------------------------------------
# site/dist on its own port, so the marketing page can be looked at locally.
LANDING_PORT = int(os.environ.get("LANDING_PORT", "8791"))


def is_owner(chat_id) -> bool:
    """May turns be auto-resumed on this chat id's behalf?

    ALLOWED_CHAT_IDS is the Telegram trust boundary, but the dashboard's sessions
    are owned by DASH_CHAT_ID — which is 0 on a Telegram-free install and so fails
    that set check. Resume paths must use this instead of the raw set, or a
    dashboard-only install silently never resumes anything (see limits._fire,
    which pops entries before checking, i.e. drops rather than defers them).
    """
    return chat_id in ALLOWED_CHAT_IDS or (
        DASH_ENABLE and chat_id is not None and chat_id == DASH_CHAT_ID)
