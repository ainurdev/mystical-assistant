"""Read-only session pages behind an unguessable link.

One route, `GET /share/<token>`, serving one session's transcript as a single
self-contained HTML page. It is the only part of the dashboard that answers
without the Host allow-list, because the token in the path *is* the
authorisation — a share has to be openable from a phone or a colleague's
machine, which by definition is not `localhost`.

What that buys, and what it costs, deliberately:

  * Read-only. No API, no run, no files, no session list. The page is rendered
    here from the store; nothing about it can act on the machine.
  * One session. A token names exactly one, and knowing one token tells you
    nothing about any other.
  * Expiring. `store.get_share` re-checks the clock on every request.
  * Text only. Screenshots and prompt attachments are NOT served: they live in
    the upload dir alongside every other run's images, and authorising a path
    per share is a bigger surface than the feature is worth. The page says so
    where an image would have been.

The dashboard binds 127.0.0.1, so by default a link only opens on this machine.
Reaching it from elsewhere is a deliberate act — putting the port behind the
tunnel, or setting DASH_HOST — not something creating a share does for you.
"""

import html
import time

from bridge import store

_MAX_OUTPUT = 4000        # chars of tool output kept per block
_MAX_EVENTS = 4000        # events rendered before the page truncates


def _ago(ts: float) -> str:
    d = max(0, int(time.time() - ts))
    if d < 60:
        return "just now"
    if d < 3600:
        return f"{d // 60}m ago"
    if d < 86400:
        return f"{d // 3600}h ago"
    return f"{d // 86400}d ago"


def _left(expires: float) -> str:
    d = max(0, int(expires - time.time()))
    if d < 3600:
        return f"{max(1, d // 60)} minutes"
    if d < 86400:
        return f"{d // 3600} hours"
    return f"{d // 86400} days"


def _esc(v) -> str:
    return html.escape(str(v or ""))


def _block(ev: dict) -> str:
    """One transcript event as HTML. Anything not worth reading on a shared page
    (permission plumbing, question bookkeeping) renders as nothing."""
    t = ev.get("type")
    if t == "text":
        return f'<div class="say">{_esc(ev.get("text"))}</div>'
    if t == "result":
        return f'<div class="result">{_esc(ev.get("result"))}</div>'
    if t == "tool":
        return (f'<div class="tool"><span class="tag">{_esc(ev.get("name"))}</span>'
                f'<span class="sum">{_esc(ev.get("summary"))}</span></div>')
    if t == "tool_done":
        out = (ev.get("output") or "").strip()
        bits = ""
        if out:
            clipped = out[:_MAX_OUTPUT]
            if len(out) > _MAX_OUTPUT:
                clipped += f"\n… {len(out) - _MAX_OUTPUT} more characters"
            bits += f'<pre class="out">{_esc(clipped)}</pre>'
        if ev.get("patch"):
            bits += f'<pre class="out">{_esc(chr(10).join(ev["patch"]))}</pre>'
        if ev.get("images"):
            n = len(ev["images"])
            bits += (f'<div class="omitted">{n} image{"" if n == 1 else "s"} '
                     "not included in a shared session</div>")
        return bits
    if t == "error":
        return f'<div class="err">{_esc(ev.get("message"))}</div>'
    return ""


def render(token: str) -> "str | None":
    """The page for `token`, or None when the share is unknown or expired."""
    share = store.get_share(token)
    if not share:
        return None
    session = store.get_session(share["session_id"])
    if not session:
        return None
    t = store.transcript(share["session_id"])
    turns = t.get("turns") or []
    by_turn: dict = {}
    for ev in (t.get("events") or [])[:_MAX_EVENTS]:
        by_turn.setdefault(ev.get("turn_id"), []).append(ev)

    title = session.get("title") or "Untitled session"
    parts = [
        f'<h1>{_esc(title)}</h1>',
        f'<div class="meta">{len(turns)} turn{"" if len(turns) == 1 else "s"} · '
        f'last active {_ago(session.get("updated") or 0)} · '
        f'link expires in {_left(share["expires"])}</div>',
    ]
    for turn in turns:
        parts.append(f'<div class="prompt">{_esc(turn.get("prompt"))}</div>')
        if turn.get("attachments"):
            n = len(turn["attachments"])
            parts.append(f'<div class="omitted">{n} attachment'
                         f'{"" if n == 1 else "s"} not included in a shared session</div>')
        for ev in by_turn.get(turn.get("id"), []):
            parts.append(_block(ev))
    return _PAGE.format(title=_esc(title), body="\n".join(parts))


# One page, one <style>, no scripts and no requests off the page — a shared
# transcript should not phone anywhere, least of all from someone else's browser.
_PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>{title}</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 0; padding: 28px 18px 64px; background: #060a0a; color: #bfe6de;
         font: 14px/1.65 ui-monospace, "JetBrains Mono", SFMono-Regular, monospace; }}
  main {{ max-width: 820px; margin: 0 auto; }}
  h1 {{ font-size: 19px; color: #dff8f2; margin: 0 0 6px; font-weight: 600; }}
  .meta {{ font-size: 11px; letter-spacing: 1px; color: #3c544f; margin-bottom: 26px; }}
  .prompt {{ margin: 26px 0 10px; padding-left: 14px; border-left: 2px solid #b9a6ff;
             color: #dff8f2; white-space: pre-wrap; overflow-wrap: anywhere; }}
  .say {{ margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }}
  .result {{ margin: 12px 0; padding: 10px 12px; border: 1px solid rgba(127,233,216,.22);
             background: rgba(127,233,216,.05); white-space: pre-wrap; overflow-wrap: anywhere; }}
  .tool {{ display: flex; gap: 9px; align-items: baseline; margin: 8px 0 2px; font-size: 12px; }}
  .tag {{ flex: none; font-size: 9px; letter-spacing: 1.4px; color: #7fe9d8;
          border: 1px solid rgba(127,233,216,.32); padding: 1px 6px; }}
  .sum {{ color: #9fc7c0; min-width: 0; overflow-wrap: anywhere; }}
  .out {{ margin: 4px 0 10px; padding: 9px 11px; background: rgba(0,0,0,.3);
          border: 1px solid rgba(127,233,216,.14); font-size: 12px;
          white-space: pre-wrap; overflow-wrap: anywhere; }}
  .err {{ margin: 10px 0; color: #e0897a; }}
  .omitted {{ margin: 6px 0; font-size: 11px; color: #3c544f; font-style: italic; }}
  footer {{ max-width: 820px; margin: 44px auto 0; padding-top: 14px;
            border-top: 1px solid rgba(127,233,216,.12);
            font-size: 10px; letter-spacing: 1px; color: #2e423f; }}
</style>
</head><body>
<main>{body}</main>
<footer>SHARED FROM MYSTICAL-ASSISTANT · READ-ONLY · THIS LINK EXPIRES</footer>
</body></html>
"""
