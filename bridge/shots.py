"""Tool pictures by session, for the sidebar's unseen-picture tag.

A tool result that carries a picture (an image Read, a Screenshot, an Attach, a
Record clip) is saved under UPLOAD_DIR/<turn id>/ and named in its tool_done
event's `images`, which is exactly what the WORK zone draws. Whether you have
looked at one lives in the browser (the dashboard's lib/seenshots, keyed by
these same absolute paths), so all this answers is which pictures exist, per
session, since a time.

Read from the events, not the upload folders: a turn's folder also holds your
own attachments and the pictures in a question's options (named after the tool
id like an Attach is), and the WORK zone never marks those seen, so counting
them would light a tag nothing could put out.

Not built: server-side seen state (the WORK plate keeps none either; it would
follow you across browsers), and a cache — the dashboard asks for one day.
"""

import time

from . import store

WINDOW = 7 * 86400  # the furthest back a caller may ask: uploads are pruned at a week


def since(chat_id: int, t: float) -> dict[str, list[list]]:
    """{session id: [[path, ts], …]} for this chat's tool pictures since `t`
    (clamped to a week back), each session's oldest first."""
    out: dict[str, list[list]] = {}
    for sid, path, ts in store.tool_images_since(chat_id, max(t, time.time() - WINDOW)):
        out.setdefault(sid, []).append([path, ts])
    for pics in out.values():
        pics.sort(key=lambda x: x[1])
    return out
