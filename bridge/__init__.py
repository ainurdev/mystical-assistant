"""Claude Code Telegram bridge — package split out of the original single file.

Modules:
  config    env-derived configuration constants
  state     shared mutable state + locks (sessions, active project, busy lock)
  telegram  Telegram Bot API helpers
  browser   project folder browser
  devserver dev-server process management
  tunnel    public quick tunnels
  runner    Claude Code runner (blocking + streaming jobs)
  dispatch  Telegram message/callback handlers (slash commands)
  miniapp   HTTP server + web UI for the Telegram Mini App
"""
