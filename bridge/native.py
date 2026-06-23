"""Discovery of native Claude Code sessions (VSCode/terminal) so they appear in
the bridge's unified session list and become resumable from any surface.

A native session lives only on disk as ~/.claude/projects/<enc-cwd>/<uuid>.jsonl.
This scanner enumerates those transcripts, recovers each one's true cwd from
inside the file, keeps only the ones under BASE_PATH (your ~/projects), and
upserts a metadata-only index row into the store (no transcript import — the
JSONL stays the source of truth, rendered on demand by transcript_jsonl).

Dedup is by claude_session_id, so a bridge-run session whose JSONL we re-encounter
is refreshed in place, not duplicated or reclassified. Stdlib only.
"""

import os
import time

from bridge import config, store, transcript_jsonl
from bridge.browser import rel, within_base

_last_scan = 0.0
_SCAN_MIN_INTERVAL = 5.0


def refresh(chat_id: int | None = None, *, force: bool = False) -> int:
    """Debounced scan() for the hot path (session-list requests), so a session
    just started in VSCode shows up without rescanning on every poll."""
    global _last_scan
    now = time.time()
    if not force and (now - _last_scan) < _SCAN_MIN_INTERVAL:
        return 0
    _last_scan = now
    return scan(chat_id)


def scan(chat_id: int | None = None) -> int:
    """Index every native session under BASE_PATH. Returns the count indexed.
    Owner defaults to the single dashboard/Telegram chat id."""
    owner = chat_id if chat_id is not None else (config.DASH_CHAT_ID or 0)
    root = transcript_jsonl.PROJECTS_DIR
    try:
        names = os.listdir(root)
    except OSError:
        return 0

    count = 0
    for name in names:
        pdir = os.path.join(root, name)
        if not os.path.isdir(pdir):
            continue
        try:
            files = [f for f in os.listdir(pdir) if f.endswith(".jsonl")]
        except OSError:
            continue
        for f in files:
            path = os.path.join(pdir, f)
            uid = f[:-len(".jsonl")]
            cwd = transcript_jsonl.recover_cwd(path)
            if not cwd or not within_base(cwd):
                continue
            title = transcript_jsonl.first_user_text(path)
            if title:
                title = title.strip()[:60]
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = None
            store.upsert_native_session(uid, owner, rel(cwd), cwd,
                                        title=title, updated=mtime, origin="vscode")
            count += 1
    return count
