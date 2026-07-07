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

c_g=$'\033[32m'; c_r=$'\033[31m'; c_y=$'\033[33m'; c_0=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$c_g" "$c_0" "$*"; }
bad()  { printf '%s✗%s %s\n' "$c_r" "$c_0" "$*"; }
warn() { printf '%s!%s %s\n' "$c_y" "$c_0" "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

doctor() {
  local hard=0
  if have claude; then ok "claude found"
  else bad "claude not found — install & log in: https://claude.com/claude-code"; hard=1; fi
  if have python3; then ok "python3 $(python3 -c 'import platform;print(platform.python_version())')"
  else bad "python3 not found (need 3.10+)"; hard=1; fi
  if python3 -c 'import requests' >/dev/null 2>&1; then ok "python 'requests' available"
  else bad "python 'requests' missing — pip install requests"; hard=1; fi
  if have cloudflared; then ok "cloudflared found"
  else warn "cloudflared not found — only needed for the Mini App panel and /preview"; fi
  if have npm; then ok "npm found (only needed to rebuild the web UI)"
  else warn "npm not found — fine unless you rebuild the web clients"; fi
  return $hard
}

get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$ENV_FILE" | head -n1 || true; }

if [ "${1:-}" = "--check-only" ]; then doctor; exit $?; fi

echo "── mystical-assistant setup ──"
if ! doctor; then echo; bad "Fix the required items above, then re-run ./setup.sh."; exit 1; fi
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# -- bot token ---------------------------------------------------------------
token="$(get_env TELEGRAM_BOT_TOKEN)"
if [ -z "$token" ]; then
  echo
  echo "Create a Telegram bot to get a token:"
  echo "  1. Open @BotFather:  https://t.me/BotFather"
  echo "  2. Send /newbot and follow the prompts (name + username)."
  echo "  3. Copy the token (looks like 123456:ABC-...)."
  printf "Paste your bot token: "; read -r token
  [ -n "$token" ] || { bad "No token entered."; exit 1; }
  "${ONBOARD[@]}" set-env "$ENV_FILE" TELEGRAM_BOT_TOKEN "$token"
  ok "token saved to .env"
fi

# -- BASE_PATH ---------------------------------------------------------------
if [ -z "$(get_env BASE_PATH)" ]; then
  printf "Root folder for your projects [%s]: " "$HOME/projects"
  read -r base; base="${base:-$HOME/projects}"
  "${ONBOARD[@]}" set-env "$ENV_FILE" BASE_PATH "$base"
  ok "BASE_PATH → $base"
fi

# -- dashboard token (stable + secure) ---------------------------------------
if [ -z "$(get_env DASH_TOKEN)" ]; then
  dtok="$(openssl rand -hex 24 2>/dev/null || python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
  "${ONBOARD[@]}" set-env "$ENV_FILE" DASH_TOKEN "$dtok"
fi

# -- chat id (auto-capture) --------------------------------------------------
if [ -z "$(get_env ALLOWED_CHAT_IDS)" ]; then
  echo
  echo "Now open Telegram and send your bot ANY message so it can learn your id…"
  cid="$("${ONBOARD[@]}" capture-chat-id "$token" || true)"
  if [ -n "$cid" ]; then
    "${ONBOARD[@]}" set-env "$ENV_FILE" ALLOWED_CHAT_IDS "$cid"
    ok "captured chat id $cid — you are the only allowed user"
  else
    warn "No message received in time. Re-run ./setup.sh, or start 'mystical',"
    warn "message the bot, and add the printed id to ALLOWED_CHAT_IDS in .env."
  fi
fi

# -- Mini App toggle ---------------------------------------------------------
if [ -z "$(get_env MINIAPP_ENABLE)" ]; then
  if have cloudflared; then
    printf "Enable the Telegram Mini App control panel? [Y/n]: "
    read -r ans; case "${ans:-y}" in [Nn]*) mini=0;; *) mini=1;; esac
  else
    warn "cloudflared missing — disabling the Mini App (bot + dashboard still work)."
    mini=0
  fi
  "${ONBOARD[@]}" set-env "$ENV_FILE" MINIAPP_ENABLE "$mini"
fi

# -- link `mystical` onto PATH -----------------------------------------------
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/bin/mystical" "$HOME/.local/bin/mystical"
ok "linked 'mystical' → ~/.local/bin/mystical"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) : ;;
  *) warn "~/.local/bin isn't on PATH. Add:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo; ok "Setup complete."
echo "Start it:   mystical"
port="$(get_env DASH_PORT)"; port="${port:-8790}"
echo "Dashboard:  http://127.0.0.1:$port/?token=$(get_env DASH_TOKEN)"
