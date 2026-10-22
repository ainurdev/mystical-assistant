"""Opt-in usage sharing: the one answer this install gave to "share anonymous usage?".

The dashboard asks once per install and loads PostHog only after a yes
(web/src/lib/usage.ts holds what it sends and what it scrubs). The answer lives
here, next to the DB, rather than in the browser: Mystical.app, Chrome and a
phone on the same bridge are one install and should be asked once, and a "no"
must survive cleared site data.

None = never asked (the dashboard asks), True/False = answered. Anything else in
the file reads as None, so a damaged file asks again instead of sharing.

Not built: events from the bridge itself. Turns and errors already sit in
bridge.db for the owner, and this module never talks to PostHog.
"""

import json
import os

from bridge import config


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "usage_sharing.json")


def answer() -> "bool | None":
    try:
        with open(_path()) as f:
            share = (json.load(f) or {}).get("share")
    except (OSError, ValueError, AttributeError):
        return None
    return share if isinstance(share, bool) else None


def set_answer(share: bool) -> bool:
    os.makedirs(os.path.dirname(_path()), exist_ok=True)
    with open(_path(), "w") as f:
        json.dump({"share": share}, f)
    return share
