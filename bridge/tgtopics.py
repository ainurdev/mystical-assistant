"""One Telegram thread per session, when the bot has topics in private chats.

Telegram lets a bot's private chat hold topics (Bot API 9.3/9.4), switched on
for the bot in @BotFather; getMe says so (has_topics_enabled), read at boot into
state.tg_topics. With it on, each session gets a topic of its own the first
time something is sent about it, named after the session: its answers, its
questions and its notices go there, and what is written there runs in it
(bridge/dispatch.py). A topic the user makes is a new session in the active
project. The chat's main thread keeps working as before: commands (answered
there, wherever they are typed), and prompts to the active project's latest
session, whose answer then comes in that session's topic.

With it off (the default: nothing to switch on here), every call answers None
and everything stays in the one chat, as it always was. A topic message coming
in says it is on, whatever boot's getMe said (bridge/dispatch.py). A topic
Telegram says is gone (telegram.gone_threads) is replaced by a new one.

ponytail: a topic's colour is one of the six Telegram allows, picked from the
project's name, so a project's sessions share one; a project with no colour of
its own may share another's. Telegram accepts no other colour without a custom
emoji, which needs Premium.
"""

import threading
import zlib

from bridge import profiles, state, store, telegram

# The six icon colours Telegram accepts for a topic (createForumTopic).
_COLORS = (0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F)
_lock = threading.Lock()


def on() -> bool:
    return bool(state.tg_topics)


def boot(me: "dict | None") -> None:
    """Whether the bot has topics in private chats, from getMe."""
    state.tg_topics = bool((me or {}).get("has_topics_enabled"))


def _name(sess: dict) -> str:
    project = (sess.get("project") or "").rstrip("/").rsplit("/", 1)[-1]
    return sess.get("title") or project or "Session"


def _color(sess: dict) -> int:
    return _COLORS[zlib.crc32((sess.get("project") or "").encode()) % len(_COLORS)]


def thread_for(chat_id: "int | None", session_id: "str | None", *, create: bool = True) -> "int | None":
    """The session's topic in this chat, made the first time one is wanted; None
    with topics off, in a group, or when Telegram won't make one (the message
    then goes to the main thread, as before)."""
    if not on() or not chat_id or chat_id <= 0 or not session_id:
        return None
    sess = store.get_session(session_id)
    if not sess or sess.get("chat_id") != chat_id:
        return None
    if (chat_id, sess.get("tg_thread")) in telegram.gone_threads:   # deleted or closed: a new one
        telegram.gone_threads.discard((chat_id, sess["tg_thread"]))
        store.set_tg_thread(session_id, None)
        sess = {**sess, "tg_thread": None}
    if sess.get("tg_thread") or not create:
        return sess.get("tg_thread")
    with _lock:   # two sends at once must not make two topics
        sess = store.get_session(session_id) or sess
        if sess.get("tg_thread"):
            return sess["tg_thread"]
        thread = telegram.create_topic(chat_id, _name(sess), _color(sess))
        if thread:
            store.set_tg_thread(session_id, thread)
        return thread


def adopt(chat_id: int, thread: int, name: str, project: str) -> dict:
    """A topic the user made (or one this bridge never saw): a new session in
    `project`, bound to it, titled after it."""
    sess = store.create_session(chat_id, project, profile_id=profiles.project_default(project))
    store.set_tg_thread(sess["id"], thread)
    if name:
        store.rename(sess["id"], name)
    return store.get_session(sess["id"]) or sess


def rename(session_id: str) -> None:
    """The session got a title (bridge/titler.py): so does its topic."""
    sess = store.get_session(session_id) if on() else None
    if sess and sess.get("tg_thread") and sess.get("chat_id", 0) > 0:
        telegram.rename_topic(sess["chat_id"], sess["tg_thread"], _name(sess))
