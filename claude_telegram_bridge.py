"""
claude_telegram_bridge.py — entry point
=======================================
A remote dev workflow over Telegram, backed by Claude Code on your machine, with a
Telegram **Mini App** control panel. The implementation lives in the `bridge/`
package; this file just wires it together and runs the Telegram long-poll loop.

From your phone:
  - /projects   browse folders under BASE_PATH and pick one
  - /app        open the Mini App: project picker + prompt+screenshots (live stream)
                + dev server controls + logs + preview link
  - /server     start the project's dev server   · /logs   recent output
  - /preview    public link to the running server · <message> prompt Claude Code

Configure via run.sh (TELEGRAM_BOT_TOKEN, BASE_PATH, ALLOWED_CHAT_IDS,
EXTRA_CLAUDE_ARGS, …). Design: docs/superpowers/specs/2026-06-22-telegram-miniapp-design.md

Requirements
------------
- Python 3.9+, `pip install requests`
- `claude` CLI installed and logged in (auth is reused; no API key).
- `cloudflared` for /preview and the Mini App tunnel.
- Mini App UI built once:
    npm --prefix bridge/miniapp/web ci && npm --prefix bridge/miniapp/web run build
- POSIX (macOS / Linux) for /server process-group control.

>>> Read the SECURITY section at the bottom before exposing this. <<<
"""

import json
import os
import sys

from bridge import config, devserver, pubsub, state, store, tunnel
from bridge.dispatch import handle_callback, on_message
from bridge.telegram import get_updates, tg


def _setup_miniapp():
    if not config.MINIAPP_ENABLE:
        print("Mini App disabled (MINIAPP_ENABLE=0).")
        return
    from bridge.miniapp import server as miniapp
    if not miniapp.web_built():
        print("⚠️  Mini App UI not built — run:\n"
              "    npm --prefix bridge/miniapp/web ci && "
              "npm --prefix bridge/miniapp/web run build\n"
              "    (the panel will return 503 until then)")
    miniapp.start()
    proc, url = tunnel.open_quick_tunnel(config.MINIAPP_PORT)
    if not url:
        print("⚠️  Mini App tunnel failed (is cloudflared installed?). "
              "Panel reachable only on localhost.")
        return
    state.miniapp_url = url
    state.miniapp_tunnel_proc = proc
    for chat in config.ALLOWED_CHAT_IDS:
        tg("setChatMenuButton", chat_id=chat, menu_button=json.dumps(
            {"type": "web_app", "text": "🛠 Open Panel", "web_app": {"url": url}}))
    print(f"Mini App live: {url}")


def _setup_dashboard():
    if not config.DASH_ENABLE:
        return
    from bridge.dashboard import server as dash
    if not dash.web_built():
        print("⚠️  Dashboard UI not built — run:\n"
              "    npm --prefix bridge/dashboard/web ci && "
              "npm --prefix bridge/dashboard/web run build")
    dash.start()
    print(f"Dashboard (localhost only): http://{config.DASH_HOST}:{config.DASH_PORT}/"
          f"?token={config.DASH_TOKEN}")


def _shutdown():
    tunnel.stop_tunnel()
    devserver.stop_server()
    if config.MINIAPP_ENABLE:
        from bridge.miniapp import server as miniapp
        miniapp.stop()
    if config.DASH_ENABLE:
        from bridge.dashboard import server as dash
        dash.stop()
    pubsub.shutdown()
    if state.miniapp_tunnel_proc and state.miniapp_tunnel_proc.poll() is None:
        state.miniapp_tunnel_proc.terminate()


def main():
    if not config.TOKEN:
        sys.exit("Set TELEGRAM_BOT_TOKEN.")
    if not os.path.isdir(config.BASE_PATH):
        sys.exit(f"BASE_PATH does not exist: {config.BASE_PATH}")
    me = tg("getMe")
    if not me:
        sys.exit("Could not reach Telegram. Check the token / network.")
    print(f"Bridge online as @{me.get('username')}  base={config.BASE_PATH}")
    store.init()
    if not config.ALLOWED_CHAT_IDS:
        print("⚠️  No ALLOWED_CHAT_IDS — DISCOVERY mode (won't execute Claude).")
    else:
        _setup_miniapp()
        _setup_dashboard()

    offset = 0
    try:
        while True:
            for upd in get_updates(offset):
                offset = upd["update_id"] + 1
                try:
                    if "callback_query" in upd:
                        handle_callback(upd["callback_query"])
                    elif "message" in upd:
                        on_message(upd["message"])
                except Exception as e:  # noqa: BLE001
                    print(f"[handler] {e}", file=sys.stderr)
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        _shutdown()


if __name__ == "__main__":
    main()

# ============================================================================
# SECURITY — read this
# ============================================================================
# Whoever is in ALLOWED_CHAT_IDS can run Claude Code AND start dev servers on this
# machine — via the bot AND via the Mini App. Both share the same chat-id trust
# boundary (the Mini App additionally verifies Telegram's signed initData). With
# --dangerously-skip-permissions that means arbitrary command execution. Mitigations:
#   1. Keep ALLOWED_CHAT_IDS locked to your own chat id(s). Never leave empty in
#      production — discovery mode is for setup only (Mini App stays off then).
#   2. Treat TELEGRAM_BOT_TOKEN as a secret (it also signs initData). run.sh is
#      git-ignored; keep it chmod 600.
#   3. The Mini App HTTP server binds 127.0.0.1 only; its sole ingress is the
#      cloudflared tunnel, and unauthenticated requests get 401.
#   4. Pick your permission posture deliberately (acceptEdits vs skip-perms).
#   5. RUN_TIMEOUT caps runaway Claude runs; keep it sane.
# ============================================================================
