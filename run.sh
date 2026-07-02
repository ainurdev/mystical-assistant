#!/usr/bin/env bash
#
# Committed launcher for claude_telegram_bridge.py. Holds NO secrets — it loads
# them from the git-ignored .env (created by ./setup.sh). Safe to commit.

set -euo pipefail
cd "$(dirname "$(realpath "$0")")"

if [ ! -f .env ]; then
  echo "No .env found — run ./setup.sh first (it creates it)." >&2
  exit 1
fi

set -a
. ./.env
set +a

exec python3 claude_telegram_bridge.py
