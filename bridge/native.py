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
import threading
import time

from bridge import config, machine, store, transcript_jsonl
from bridge.browser import rel, within_base

_last_scan = 0.0
_SCAN_MIN_INTERVAL = 5.0
_scan_lock = threading.Lock()
# path -> (mtime, indexed?) of transcripts already processed, so a rescan skips
# unchanged files (each scan otherwise re-reads every transcript twice: cwd +
# title). The indexed flag lets the return count stay correct without re-reading.
_scanned: "dict[str, tuple]" = {}

# Prefix stamped on the bridge's internal one-shot prompts (commit-message
# generation, preview detection). Those headless runs still persist a JSONL under
# ~/.claude/projects, so scan() skips any transcript whose first user message
# starts with this — they must never surface in the unified session list. Not
# angle-bracket shaped so transcript_jsonl.first_user_text won't strip it.
INTERNAL_ONESHOT_TAG = "[[mystical-internal]]"

# Internal one-shots created before the tag existed still sit on disk untagged,
# and scan() re-reads every transcript on each poll — so without a content match
# they resurface after cleanup. Match their stable prompt openings too. Safe to
# drop once the pre-tag backlog ages out of the list window.
_LEGACY_INTERNAL_PREFIXES = (
    "You are configuring a one-click 'preview' button",
    "Write a single git commit message for the staged changes",
)


def _is_internal_oneshot(title: str) -> bool:
    """True for the bridge's own headless generator prompts (commit-message,
    preview command) — tagged going forward, matched by prefix for the backlog."""
    return (title.startswith(INTERNAL_ONESHOT_TAG)
            or title.startswith(_LEGACY_INTERNAL_PREFIXES))


def refresh(chat_id: int | None = None, *, force: bool = False) -> int:
    """Debounced scan() for the hot path (session-list requests), so a session
    just started in VSCode shows up without rescanning on every poll."""
    global _last_scan
    now = time.time()
    with _scan_lock:
        if not force and (now - _last_scan) < _SCAN_MIN_INTERVAL:
            return 0
        _last_scan = now       # claim the scan under the lock — two concurrent
        # request threads must not both pass the debounce and rescan at once.
    return scan(chat_id)


def _index_running(owner: int) -> int:
    """Index the sessions Claude Code's own registry says are alive right now,
    from that registry instead of from disk. The transcript scan below is blind
    to two live ones: a session started seconds ago has written no JSONL yet, and
    one started outside BASE_PATH is skipped on purpose. Both are sessions of
    yours, so both belong in the list and stay resumable (continuation runs in the
    row's stored cwd, which needn't be under BASE_PATH).

    An out-of-base row carries its ~-collapsed path as the project label —
    browser.project_exists accepts that form. Only *live* out-of-base sessions are
    indexed; the disk scan stays base-scoped, so old transcripts from everywhere
    else don't flood the list.

    ponytail: an out-of-base row has no matching project group, so it shows in
    RECENT but not under BY PROJECT. Give it a group only if you actually want the
    session list to browse outside your projects root."""
    count = 0
    for r in machine.list_running():
        sid, short = r.get("session_id"), r.get("cwd") or ""
        cwd = os.path.expanduser(short)
        if not sid or not os.path.isdir(cwd):
            continue
        store.upsert_native_session(
            sid, owner, rel(cwd) if within_base(cwd) else short, cwd,
            updated=r.get("last_active") or r.get("started"),
            origin="vscode" if r.get("source") == "vscode" else "terminal")
        count += 1
    return count


def scan(chat_id: int | None = None) -> int:
    """Index every native session under BASE_PATH, plus whatever is running right
    now (see _index_running). Returns the count indexed. Owner defaults to the
    single dashboard/Telegram chat id."""
    owner = chat_id if chat_id is not None else (config.DASH_CHAT_ID or 0)
    count = _index_running(owner)
    root = transcript_jsonl.PROJECTS_DIR
    try:
        names = os.listdir(root)
    except OSError:
        return count

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
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            # Unchanged since we last processed it → skip the two full-file reads
            # (upsert uses MAX(updated) + preserves title/archived, so re-running
            # it is a no-op). Still count it if it was an indexed under-base
            # session, so the return value matches a cold scan.
            cached = _scanned.get(path)
            if cached and cached[0] == mtime:
                if cached[1]:
                    count += 1
                continue
            cwd, origin = transcript_jsonl.recover_meta(path)
            indexed = bool(cwd and within_base(cwd))
            if indexed:
                title = transcript_jsonl.first_user_text(path)
                if title and _is_internal_oneshot(title):
                    indexed = False               # bridge-internal one-shot — never list
                else:
                    store.upsert_native_session(uid, owner, rel(cwd), cwd,
                                                title=title.strip()[:60] if title else None,
                                                updated=mtime, origin=origin)
                    count += 1
            # Classification is a pure function of file content, so cache it: an
            # unchanged file always yields the same indexed/skip outcome.
            _scanned[path] = (mtime, indexed)
    return count
