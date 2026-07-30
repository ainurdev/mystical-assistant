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

PATH_ORIG="$PATH"                      # remember what the user's shell really has
export PATH="$HOME/.local/bin:$PATH"   # so a tunnel client/mystical we install is visible now

doctor() {
  local hard=0
  if have claude; then ok "claude found"
  else bad "claude not found — install & log in: https://claude.com/claude-code"; hard=1; fi
  if ! have python3; then bad "python3 not found (need 3.10+)"; hard=1
  elif python3 -c 'import sys;sys.exit(sys.version_info<(3,10))'; then
    ok "python3 $(python3 -c 'import platform;print(platform.python_version())') (no pip packages needed)"
  else bad "python3 is $(python3 -c 'import platform;print(platform.python_version())') — need 3.10+"; hard=1; fi
  if have cloudflared; then ok "tunnel client found"
  else warn "tunnel client not found — only needed for the Mini App panel and /preview"; fi
  if have npm; then ok "npm found (only needed to rebuild the web UI)"
  else warn "npm not found — fine unless you rebuild the web clients"; fi
  if have graphify; then ok "graphify found (projects map themselves after the first turn)"
  else warn "graphify not found — no project maps. Install: pipx install graphifyy"; fi
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

get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$ENV_FILE" | head -n1 || true; }

if [ "${1:-}" = "--check-only" ]; then doctor; exit $?; fi

echo "── mystical-assistant setup ──"
if ! doctor; then echo; bad "Fix the required items above, then re-run ./setup.sh."; exit 1; fi
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# -- bot token (validated, so a typo fails here and not at first run) ---------
token="$(get_env TELEGRAM_BOT_TOKEN)"
botname="$([ -n "$token" ] && "${ONBOARD[@]}" get-me "$token" || true)"
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
fi
ok "bot @$botname — https://t.me/$botname"

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
  echo "Now open https://t.me/$botname and send it ANY message (or tap Start)"
  echo "so it can learn your chat id…"
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
  echo
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
  printf "Enable the Telegram Mini App control panel (phone UI)? [Y/n]: "
  read -r ans; case "${ans:-y}" in [Nn]*) mini=0;; *) mini=1;; esac
  if [ "$mini" = 1 ] && ! have cloudflared; then
    printf "It needs a small tunnel client, which isn't installed. Install it now? [Y/n]: "
    read -r ans; case "${ans:-y}" in
      [Nn]*) mini=0;;
      *) if install_tunnel_client; then ok "tunnel client installed"
         else warn "install failed — disabling the Mini App (bot + dashboard still work)."; mini=0; fi;;
    esac
  fi
  "${ONBOARD[@]}" set-env "$ENV_FILE" MINIAPP_ENABLE "$mini"
fi

# -- link `mystical` onto PATH -----------------------------------------------
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/bin/mystical" "$HOME/.local/bin/mystical"
ok "linked 'mystical' → ~/.local/bin/mystical"
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

echo; ok "Setup complete."
port="$(get_env DASH_PORT)"; port="${port:-8790}"
echo "Dashboard:  http://127.0.0.1:$port/?token=$(get_env DASH_TOKEN)"
printf "Start the bridge now? [Y/n]: "
read -r ans || ans=n; case "${ans:-y}" in   # EOF (piped/CI) = don't start
  [Nn]*) echo "Start it later with:  mystical" ;;
  *) exec "$HOME/.local/bin/mystical" ;;
esac
