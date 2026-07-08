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

On your machine (printed on startup, localhost only, never tunneled):
  - Dashboard at http://127.0.0.1:8790/?token=… — a full desktop Claude client
    (per-project sessions, prompts + cards, model/effort, server/preview controls)
    with live per-session/project Claude streams and dev-server logs side by side.

Conversations are the single source of truth in a SQLite store (~/.bridge_state/),
shared by the bot, the Mini App, and the dashboard. Configure via run.sh
(TELEGRAM_BOT_TOKEN, BASE_PATH, ALLOWED_CHAT_IDS, EXTRA_CLAUDE_ARGS, DASH_PORT, …).
Design: docs/superpowers/specs/2026-06-23-unified-sessions-dashboard-design.md

Requirements
------------
- Python 3.10+, `pip install requests`
- `claude` CLI installed and logged in (auth is reused; no API key).
- `cloudflared` for /preview and the Mini App tunnel.
- Mini App + Dashboard UIs built once:
    npm --prefix bridge/miniapp/web ci   && npm --prefix bridge/miniapp/web run build
    npm --prefix bridge/dashboard/web ci && npm --prefix bridge/dashboard/web run build
- POSIX (macOS / Linux) for /server process-group control.

>>> Read the SECURITY section at the bottom before exposing this. <<<
"""

import json
import os
import signal
import sys

from bridge import config, devserver, native_activity, pubsub, recovery, state, store, tunnel
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
    url = f"http://{config.DASH_HOST}:{config.DASH_PORT}/"
    if config.DASH_TOKEN:
        url += f"?token={config.DASH_TOKEN}"
    print(f"Dashboard (localhost only): {url}")


def _on_stop_signal(signum, frame):
    # Flag first, then unwind: runner threads watching their Claude child die must
    # already see shutting_down, or they'd record the killed turn as an error and
    # startup recovery would find nothing to resume.
    state.shutting_down = True
    raise KeyboardInterrupt


def _shutdown():
    state.shutting_down = True
    native_activity.stop()
    tunnel.stop_tunnel()
    devserver.stop_all()      # every registered dev server, not just the primary
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
    signal.signal(signal.SIGINT, _on_stop_signal)
    signal.signal(signal.SIGTERM, _on_stop_signal)   # bare `kill` now shuts down cleanly too
    store.init()
    if not config.ALLOWED_CHAT_IDS:
        print("⚠️  No ALLOWED_CHAT_IDS — DISCOVERY mode (won't execute Claude).")
        recovery.recover()             # flip restart-orphaned turns (no resume in discovery)
    else:
        _setup_miniapp()
        _setup_dashboard()
        native_activity.start()        # tail live VS Code/terminal sessions
        resumed = recovery.recover()   # resume turns a restart interrupted (--resume + nudge)
        if resumed:
            print(f"↻ Auto-resumed {resumed} interrupted session(s) after restart.")

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
