"""Shared mutable state and locks, used by both the bot and the Mini App.

Reassignable module attributes (busy_chat, miniapp_url, miniapp_tunnel_proc) are
accessed and mutated as ``state.X`` from other modules.
"""

import threading

from bridge import config

sessions: dict[int, str] = {}    # chat_id -> Claude session_id
active: dict[int, str] = {}      # chat_id -> selected project path
browse: dict[int, str] = {}      # chat_id -> current browser directory

busy = threading.Lock()          # one Claude run at a time (bot + Mini App share it)
busy_chat: int | None = None     # which chat currently holds `busy`

miniapp_url: str | None = None             # current public Mini App URL
miniapp_tunnel_proc = None                 # subprocess.Popen for the Mini App tunnel


def project_dir(chat_id: int) -> str:
    """The directory Claude runs in for a chat: selected project, else default/base."""
    return active.get(chat_id) or config.DEFAULT_PROJECT or config.BASE_PATH
