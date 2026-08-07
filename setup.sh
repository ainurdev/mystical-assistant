#!/usr/bin/env bash
#
# setup.sh — one-command onboarding for mystical-assistant.
# Idempotent: re-run any time; it only asks for what's still missing.
#   ./setup.sh              full wizard
#   ./setup.sh --check-only prereq doctor, then exit (used by `mystical doctor`)

set -euo pipefail
REPO="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
ENV_FILE="$REPO/.env"
ONBOARD=(python3 "$REPO/bridge/onboard.py")

# Colour only on a terminal: `mystical doctor` pipes this, and escape codes in a
# log or a CI capture are noise.
if [ -t 1 ]; then
  c_g=$'\033[32m'; c_r=$'\033[31m'; c_y=$'\033[33m'; c_c=$'\033[36m'
  c_d=$'\033[2m';  c_b=$'\033[1m';  c_0=$'\033[0m'
else
  c_g=; c_r=; c_y=; c_c=; c_d=; c_b=; c_0=
fi
ok()   { printf '  %s✔%s %s\n' "$c_g" "$c_0" "$*"; }
bad()  { printf '  %s✘%s %s\n' "$c_r" "$c_0" "$*"; }
warn() { printf '  %s▲%s %s\n' "$c_y" "$c_0" "$*"; }
# Only the questions we actually ask get a heading, so a re-run that has nothing
# to ask stays quiet instead of printing a wall of skipped steps. $1 is the icon,
# so each step is recognisable at a glance while scrolling back.
step() { printf '\n%s%s  %s%s%s\n' "$c_b" "$1" "$c_c" "${*:2}" "$c_0"; }
have() { command -v "$1" >/dev/null 2>&1; }
# opencode's own installer drops it in ~/.opencode/bin, which is off PATH until
# a new shell — probe both, the way freeagent.py resolves the binary.
have_opencode() { have opencode || [ -x "$HOME/.opencode/bin/opencode" ]; }

PATH_ORIG="$PATH"                      # remember what the user's shell really has
export PATH="$HOME/.local/bin:$PATH"   # so a tunnel client/mystical we install is visible now

doctor() {
  local hard=0
  printf '%s🔧  Required%s\n' "$c_b" "$c_0"
  if have claude; then ok "claude"
  else bad "claude — install it and log in: https://claude.com/claude-code"; hard=1; fi
  if ! have python3; then bad "python3 — not installed (need 3.10+)"; hard=1
  elif python3 -c 'import sys;sys.exit(sys.version_info<(3,10))'; then
    ok "python3 $(python3 -c 'import platform;print(platform.python_version())') — no pip packages needed"
  else bad "python3 $(python3 -c 'import platform;print(platform.python_version())') — need 3.10+"; hard=1; fi
  printf '\n%s🧩  Optional%s %s— each one you skip only turns its own feature off%s\n' \
    "$c_b" "$c_0" "$c_d" "$c_0"
  if have npm; then ok "npm — builds the dashboard and Mini App"
  else warn "npm — missing: the bot runs, but the dashboard and Mini App can't be built"; fi
  if have cloudflared; then ok "tunnel client — lets your phone reach the Mini App"
  else warn "tunnel client — missing: no Mini App on your phone (setup offers to install it)"; fi
  if have_opencode; then ok "opencode — free-agent fallback when the Claude accounts run out"
  else warn "opencode — missing: sessions stop at the usage limit (setup offers to install it)"; fi
  if have graphify; then ok "graphify — projects map themselves after the first turn"
  else warn "graphify — missing: no project maps. Install: pipx install graphifyy"; fi
  return $hard
}

# Fetch the tunnel client for the user rather than sending them to a download page.
install_tunnel_client() {
  mkdir -p "$HOME/.local/bin"
  if [ "$(uname -s)" = "Darwin" ]; then
    have brew || { warn "Homebrew not found — install the tunnel client manually."; return 1; }
    brew install cloudflared >/dev/null || return 1
  else
    local a; case "$(uname -m)" in
      x86_64) a=amd64;; aarch64|arm64) a=arm64;; armv7l) a=arm;;
      *) warn "unsupported arch $(uname -m) — install the tunnel client manually."; return 1;;
    esac
    curl -fsSL -o "$HOME/.local/bin/cloudflared" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$a" || return 1
    chmod +x "$HOME/.local/bin/cloudflared"
  fi
  have cloudflared
}

# Same for the free-agent rung. opencode's installer already covers the
# os/arch/musl/CPU-baseline matrix, so call it instead of guessing a release
# asset — but keep it out of the user's shell rc and link it into ~/.local/bin,
# which setup already puts on PATH and freeagent.py already looks in.
install_opencode() {
  curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path >/dev/null || return 1
  [ -x "$HOME/.opencode/bin/opencode" ] || return 1
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"
}

get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$ENV_FILE" | head -n1 || true; }

if [ "${1:-}" = "--check-only" ]; then doctor; exit $?; fi

printf '\n%s✦ mystical%s//%sassistant%s %ssetup%s\n' "$c_c" "$c_d" "$c_0$c_c" "$c_0" "$c_d" "$c_0"
printf '%sAnswers are saved to .env, so a re-run only asks for what'"'"'s still missing.%s\n\n' "$c_d" "$c_0"
if ! doctor; then echo; bad "Fix the required items above, then re-run ./setup.sh."; exit 1; fi
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# -- bot token (validated, so a typo fails here and not at first run) ---------
token="$(get_env TELEGRAM_BOT_TOKEN)"
botname="$([ -n "$token" ] && "${ONBOARD[@]}" get-me "$token" || true)"
if [ -z "$botname" ]; then step "🤖" "Telegram bot"; fi
while [ -z "$botname" ]; do
  echo
  echo "Create a Telegram bot to get a token:"
  echo "  1. Open @BotFather:  https://t.me/BotFather"
  echo "  2. Send /newbot and follow the prompts (name + username)."
  echo "  3. Copy the token (looks like 123456:ABC-...)."
  printf "Paste your bot token: "; read -r token
  [ -n "$token" ] || { bad "No token entered."; exit 1; }
  botname="$("${ONBOARD[@]}" get-me "$token" || true)"
  [ -n "$botname" ] || bad "Telegram rejected that token — check it and try again."
done
if [ "$token" != "$(get_env TELEGRAM_BOT_TOKEN)" ]; then
  "${ONBOARD[@]}" set-env "$ENV_FILE" TELEGRAM_BOT_TOKEN "$token"
  # Only on a new/changed token, so a re-run never clobbers a picture you chose.
  "${ONBOARD[@]}" set-avatar "$token" >/dev/null 2>&1 || true
fi
ok "bot @$botname — https://t.me/$botname"

# -- BASE_PATH ---------------------------------------------------------------
if [ -z "$(get_env BASE_PATH)" ]; then
  step "📁" "Projects folder"
  echo "Every project you can pick from Telegram lives under this folder."
  printf "Root folder for your projects [%s]: " "$HOME/projects"
  read -r base; base="${base:-$HOME/projects}"
  "${ONBOARD[@]}" set-env "$ENV_FILE" BASE_PATH "$base"
  ok "BASE_PATH → $base"
fi

# -- dashboard token (stable + secure) ---------------------------------------
# Key presence, not value: DASH_TOKEN="" is a deliberate choice (localhost-only
# dashboard, no token gate), and a re-run must not mint one and break the URL.
if ! grep -q '^DASH_TOKEN=' "$ENV_FILE"; then
  dtok="$(openssl rand -hex 24 2>/dev/null || python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
  "${ONBOARD[@]}" set-env "$ENV_FILE" DASH_TOKEN "$dtok"
fi

# -- chat id (auto-capture) --------------------------------------------------
if [ -z "$(get_env ALLOWED_CHAT_IDS)" ]; then
  step "💬" "Your chat"
  echo "Only chat ids listed here can drive Claude on this machine."
  echo "Open https://t.me/$botname and send it ANY message (or tap Start)"
  echo "so it can learn yours…"
  cid="$("${ONBOARD[@]}" capture-chat-id "$token" || true)"
  if [ -n "$cid" ]; then
    "${ONBOARD[@]}" set-env "$ENV_FILE" ALLOWED_CHAT_IDS "$cid"
    ok "captured chat id $cid — you are the only allowed user"
  else
    warn "No message received in time. Re-run ./setup.sh, or start 'mystical',"
    warn "message the bot, and add the printed id to ALLOWED_CHAT_IDS in .env."
  fi
fi

# -- permission posture (an explicit choice, never a silent default) ----------
# Sessions started from the dashboard or Mini App carry this mode, so it decides
# whether Claude runs commands on your machine without asking. Shipping a default
# would mean strangers cloning this get full autonomy they never opted into.
if [ -z "$(get_env NEW_SESSION_PERMISSION_MODE)" ]; then
  step "🔐" "Permissions"
  echo "How should Claude behave in sessions you start from the dashboard or phone?"
  echo "  1) Ask before running commands  — edits files freely, asks for the rest"
  echo "  2) Full autonomy               — runs commands without asking (fastest,"
  echo "                                    and a prompt injection runs as you)"
  printf "Choose [1/2, default 1]: "
  read -r ans || ans=1
  case "${ans:-1}" in
    2) mode="bypassPermissions"; extra="--dangerously-skip-permissions" ;;
    *) mode="acceptEdits";       extra="--permission-mode acceptEdits" ;;
  esac
  "${ONBOARD[@]}" set-env "$ENV_FILE" NEW_SESSION_PERMISSION_MODE "$mode"
  "${ONBOARD[@]}" set-env "$ENV_FILE" EXTRA_CLAUDE_ARGS "$extra"
  ok "permission posture → $mode (change it in .env any time)"
fi

# -- Mini App toggle ---------------------------------------------------------
if [ -z "$(get_env MINIAPP_ENABLE)" ]; then
  step "📱" "Phone Mini App"
  echo "A control panel that opens inside Telegram: start sessions, watch them"
  echo "stream, browse files. Your phone reaches this machine over a tunnel, so"
  echo "no router port is opened; only your chat id can use it."
  printf "Enable it? [Y/n]: "
  read -r ans; case "${ans:-y}" in [Nn]*) mini=0;; *) mini=1;; esac
  if [ "$mini" = 1 ] && ! have cloudflared; then
    printf "It needs a small tunnel client, which isn't installed. Install it now? [Y/n]: "
    read -r ans; case "${ans:-y}" in
      [Nn]*) warn "skipped — the panel stays on localhost only"; mini=0;;
      *) if install_tunnel_client; then ok "tunnel client installed"
         else warn "install failed — disabling the Mini App (bot + dashboard still work)."; mini=0; fi;;
    esac
  fi
  "${ONBOARD[@]}" set-env "$ENV_FILE" MINIAPP_ENABLE "$mini"
fi

# -- free-agent fallback -----------------------------------------------------
# The ladder's last rung hands a limited turn to a non-Anthropic model through
# opencode. Offering the install here is why the dashboard never has to ask
# anyone to paste a curl command. Asked only while it's missing, so a re-run
# skips it once installed.
if ! have_opencode; then
  step "🪄" "Free-agent fallback"
  echo "When your Claude accounts run out of quota, sessions can hand off to a free"
  echo "provider (opencode zen, Gemini, Qwen, local Ollama). That runs through the"
  echo "'opencode' CLI — a ~60MB download. Provider keys are added later, in the dashboard."
  printf "Install it now? [Y/n]: "
  read -r ans || ans=n                 # EOF (piped/CI) = don't download
  case "${ans:-y}" in
    [Nn]*) warn "skipped — re-run ./setup.sh any time to install it" ;;
    *) echo "Downloading opencode…"
       if install_opencode; then ok "opencode installed → ~/.local/bin/opencode"
       else warn "install failed — free-agent rungs stay off (bot, dashboard and Claude are unaffected)."; fi ;;
  esac
fi

# -- link `mystical` onto PATH -----------------------------------------------
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/bin/mystical" "$HOME/.local/bin/mystical"
ok "linked 'mystical' → ~/.local/bin/mystical"

# -- build the web bundles (dist/ is git-ignored, so a fresh clone has none) ---
"$REPO/bin/mystical" build

case ":${PATH_ORIG:-$PATH}:" in
  *":$HOME/.local/bin:"*) : ;;
  *) rc="$HOME/.bashrc"; case "${SHELL:-}" in *zsh) rc="$HOME/.zshrc";; esac
     printf "~/.local/bin isn't on your PATH. Add it to %s? [Y/n]: " "${rc/#$HOME/\~}"
     read -r ans || ans=n; case "${ans:-y}" in
       [Nn]*) warn "Add manually:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
       *) printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
          ok "added to ${rc/#$HOME/\~} (open a new shell, or run: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
     esac ;;
esac

# -- recap: on a re-run this is the only output, so it has to stand alone -----
step "✨" "Ready"
port="$(get_env DASH_PORT)"; port="${port:-8790}"
dtok="$(get_env DASH_TOKEN)"
dash="http://127.0.0.1:$port/"
if [ -n "$dtok" ]; then dash="$dash?token=$dtok"; fi
case "$(get_env NEW_SESSION_PERMISSION_MODE)" in
  bypassPermissions) perm="${c_y}full autonomy${c_0} — runs commands without asking" ;;
  *)                 perm="asks before running commands" ;;
esac
case "$(get_env MINIAPP_ENABLE)" in
  1) mini="${c_g}on${c_0}" ;;
  *) mini="${c_d}off${c_0}" ;;
esac
row() { printf '  %s  %s%-11s%s %s\n' "$1" "$c_d" "$2" "$c_0" "$3"; }
row 🤖 bot         "@$botname $c_d—$c_0 https://t.me/$botname"
row 📁 projects    "$(get_env BASE_PATH)"
row 🔐 permissions "$perm"
row 📱 "mini app"  "$mini"
row 🌐 dashboard   "$dash"
echo
printf '%sThen:%s  %smystical status%s · %smystical logs%s · %smystical stop%s\n' \
  "$c_d" "$c_0" "$c_c" "$c_0" "$c_c" "$c_0" "$c_c" "$c_0"
printf "Start the bridge now? [Y/n]: "
read -r ans || ans=n; case "${ans:-y}" in   # EOF (piped/CI) = don't start
  [Nn]*) echo "Start it later with:  mystical" ;;
  *) exec "$HOME/.local/bin/mystical" ;;
esac
