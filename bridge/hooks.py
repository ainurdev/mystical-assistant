"""Inbound events: the first thing on this machine an outsider can ring.

Everything else the bridge reacts to is a human message or a timer. This adds one
route -- POST /hook/<token> on the Mini App server -- so GitHub, a CI run, an
error monitor or another machine can wake it. That server is the one the
Cloudflare tunnel fronts, and the route sits outside /api/* because a webhook
sender cannot produce the signed Telegram initData every /api/* request needs.
It is the same carve-out bridge/share.py makes on the dashboard, for the same
reason: the token in the path *is* the authorisation.

What this deliberately cannot do is start a run. A POST that spawns Claude here
is remote code execution by design, so the first slice only notifies -- Telegram
push, event recorded, nothing on the machine touched. Promoting a hook to queue
or run work is an `action` column and a branch in receive(); it is not smuggled
in early behind a flag nobody set.

No per-source parsers. A GitHub push, a Sentry alert and a CI callback share no
structure, and four sources times N event types of parsing is a standing tax that
buys one line of notification text. The payload is stored whole and summarize()
does a shallow breadth-first scan for the first title-ish and url-ish key it
recognises. When a source's shape defeats it the message degrades to the label
and the source, which is still enough to go and look. When a hook eventually does
start a run, the model reads the raw payload and needs none of this.

Signature checking is opportunistic: a hook with a secret must present a matching
HMAC (GitHub's X-Hub-Signature-256, Sentry's Sentry-Hook-Signature), a hook
without one rests on the path token alone. Both compares are constant-time.

Stdlib only. Nothing here raises into the request -- a receive that fails is a
dropped event, not a 500 that teaches a sender to retry forever.
"""

import hashlib
import hmac
import json

from bridge import config, store

# A webhook body is a notification, not an upload. GitHub's largest documented
# payloads sit under 1 MB; past this it is not a payload we could use anyway.
MAX_BODY = 1 << 20

# What the minting UI offers. 'generic' is the escape hatch: any sender that can
# POST JSON, authorised by the path token alone.
SOURCES = ("github", "sentry", "ci", "generic")

# Checked in order and order beats depth (see _walk): the specific key must win
# over the ambient one, or every GitHub issue event reports its "action".
_TITLE_KEYS = ("title", "subject", "headline", "summary", "message",
               "name", "action", "event", "status", "text")
_URL_KEYS = ("html_url", "web_url", "browse_url", "url", "link", "permalink")

# Header -> the prefix its digest carries. GitHub writes "sha256=<hex>", Sentry
# writes bare hex.
_SIG_HEADERS = (("X-Hub-Signature-256", "sha256="),
                ("Sentry-Hook-Signature", ""))

# One line of Telegram, and a cap on what a hostile sender can make us store.
_TITLE_MAX = 200
_PAYLOAD_MAX = 100_000


def _walk(payload, keys, depth: int = 3):
    """First non-empty string under the earliest of `keys` to appear anywhere.

    Key order dominates depth, and that is the whole trick. A GitHub issue
    payload carries {"action": "opened"} at the top and the headline you
    actually want one level down in {"issue": {"title": ...}} -- so preferring
    the shallowest match would report "opened" for every issue event ever sent.
    Nodes are still gathered breadth-first, so when one key appears at two
    depths the shallower still wins.
    """
    nodes, level = [], [payload]
    for _ in range(depth):
        nodes.extend(n for n in level if isinstance(n, dict))
        nxt = []
        for node in level:
            if isinstance(node, dict):
                nxt.extend(node.values())
            elif isinstance(node, list):
                nxt.extend(node)
        level = [n for n in nxt if isinstance(n, (dict, list))]
        if not level:
            break
    for k in keys:
        for node in nodes:
            v = node.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()[:_TITLE_MAX]
    return None


def summarize(payload):
    """(title, url) for the notification line. Either may be None."""
    if not isinstance(payload, (dict, list)):
        return None, None
    return _walk(payload, _TITLE_KEYS), _walk(payload, _URL_KEYS)


def verify_signature(secret: str, raw: bytes, headers) -> bool:
    """True when `raw` carries a digest matching `secret`.

    A hook that has a secret must present one of the known signature headers; an
    absent header fails rather than passes, or the secret would be advisory.
    """
    want = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    for header, prefix in _SIG_HEADERS:
        got = (headers.get(header) or "").strip()
        if got.startswith(prefix) and hmac.compare_digest(got[len(prefix):], want):
            return True
    return False


def receive(token: str, raw: bytes, headers):
    """Record and announce one inbound event; None when the caller isn't allowed.

    None is the only failure the route distinguishes, and it answers 404 to it: a
    wrong token learns nothing about whether it was unknown or merely unsigned.
    """
    hook = store.get_hook(token)
    if hook is None:
        return None
    if hook["secret"] and not verify_signature(hook["secret"], raw, headers):
        return None
    try:
        payload = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError):
        # Not JSON. Keep it anyway -- a sender misconfigured today is a sender
        # you want to see the body of, and the excerpt is what tells you which.
        payload = {"_raw": (raw or b"")[:2000].decode("utf-8", "replace")}
    title, url = summarize(payload)
    ev = store.record_hook_event(token, hook["source"], title, url,
                                 json.dumps(payload)[:_PAYLOAD_MAX])
    _notify(hook, ev)
    return ev


def _notify(hook: dict, ev: dict) -> None:
    """Push to every allowed chat, best-effort. A Telegram outage must not become
    a 500 that teaches the sender to retry the same event forever."""
    from bridge.telegram import send  # late: telegram imports config, not us
    line = f"*{hook['label']}* · `{hook['source']}`"
    if ev.get("title"):
        line += f"\n{ev['title']}"
    if ev.get("url"):
        line += f"\n{ev['url']}"
    for chat in config.ALLOWED_CHAT_IDS:
        try:
            send(chat, line)
        except Exception:
            pass


def hook_url(token: str) -> str:
    """The address to paste into the sender. With no tunnel configured there is
    no public host to offer, so the bare path is returned and the UI says so."""
    host = config.PREVIEW_HOSTNAME
    return f"https://{host}/hook/{token}" if host else f"/hook/{token}"
