"""Auto-title a session with a short 'subject' after its first turn — the way
the Claude app names a chat — replacing the first-prompt placeholder.

Best-effort: every call is guarded and swallows its own errors so nothing here
can raise into the turn lifecycle. The model call goes through
runner.run_blocking (one-shot, cheap model, no memory pack)."""

import sys

from bridge import config, runner, store

_SYS = (
    "You name a chat for a sidebar. Given the user's first message and the "
    "assistant's reply, produce a 3-6 word title summarizing the topic. Use "
    "Title Case. No surrounding quotes, no trailing punctuation, no emoji, no "
    "markdown. Respond with ONLY the title."
)

_MAX = 60                                  # matches the provisional-title cap
_WRAP = " \t\"'`.!,;:—–-"                   # trimmed from both ends of a title


def _clean(raw: str) -> str:
    """Reduce a model reply to one tidy title line: drop code fences, take the
    first non-empty line, unwrap quotes/punctuation, collapse whitespace, cap."""
    s = (raw or "").replace("`", " ")
    line = next((ln.strip() for ln in s.splitlines() if ln.strip()), "")
    line = " ".join(line.strip(_WRAP).split())
    return line[:_MAX].strip(_WRAP).strip()


def generate_after_turn(chat_id: int, session: dict, turn_id: str) -> None:
    """After a session's FIRST turn, replace its provisional first-prompt title
    with a generated subject. No-op unless the title is still 'auto' and this is
    the only turn (so we never retro-title existing chats or clobber a rename)."""
    try:
        if not getattr(config, "TITLE_ENABLE", True):
            return
        sid = session["id"]
        fresh = store.get_session(sid)
        if not fresh or fresh.get("title_source") != "auto":
            return                         # manual rename or already subjected
        t = store.transcript(sid)
        turns = t.get("turns") or []
        if len(turns) != 1:
            return                         # only the first turn — no backfill
        prompt = (turns[0].get("prompt") or "").strip()
        if not prompt:
            return
        reply = "\n\n".join(
            (e.get("text") or e.get("result") or "")
            for e in t.get("events", [])
            if e.get("turn_id") == turn_id and e.get("type") in ("text", "result")
        ).strip()
        subject = _generate(chat_id, session.get("project"), prompt, reply)
        if subject:
            store.set_subject_title(sid, subject)
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[titler] generate failed: {e}", file=sys.stderr)


def _generate(chat_id: int, project: str | None, prompt: str, reply: str) -> str:
    convo = f"USER:\n{prompt[:1500]}"
    if reply:
        convo += f"\n\nASSISTANT:\n{reply[:2000]}"
    full = f"{_SYS}\n\n=== CONVERSATION ===\n{convo}"
    try:
        text, _sid, _cost, is_error = runner.run_blocking(
            chat_id, full, cwd=project or None, timeout=45,
            model="haiku", skip_pack=True)
    except Exception as e:  # noqa: BLE001
        print(f"[titler] model call failed: {e}", file=sys.stderr)
        return ""
    return "" if is_error else _clean(text)
