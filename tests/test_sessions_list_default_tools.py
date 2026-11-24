"""A sessions list reads the default deny rules once, not once per session
(2026-11-23: 648 reads, each its own SQLite connection, made /local/sessions take
up to 12 s on a busy bridge, past the boot intro's 8 s ceiling). A session that set
its own rules still gets its own.
Run: python -m pytest tests/test_sessions_list_default_tools.py -q"""

import os
import uuid

from bridge import config, store
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini

store.init()
CHAT = config.DASH_CHAT_ID


def _project_with_sessions(n=5):
    rel = f"/org/p-{uuid.uuid4().hex[:8]}"
    os.makedirs(os.path.join(config.BASE_PATH, rel.lstrip("/")), exist_ok=True)
    ids = [store.create_session(CHAT, rel, origin="dashboard")["id"] for _ in range(n)]
    store.set_disabled_tools(ids[0], ["mcp__own"])
    return rel, ids[0]


def _count_default_reads(monkeypatch):
    reads = []
    real = store.default_disabled_tools
    monkeypatch.setattr(store, "default_disabled_tools", lambda: reads.append(1) or real())
    return reads, real()


def _check(sessions, own, default):
    assert len(sessions) == 5
    for b in sessions:
        assert b["disabled_tools"] == (["mcp__own"] if b["id"] == own else default)


def test_dashboard_list_reads_the_default_once(monkeypatch):
    rel, own = _project_with_sessions()
    reads, default = _count_default_reads(monkeypatch)
    out = dash._sessions_payload(CHAT, rel)
    assert len(reads) == 1
    _check(out["sessions"], own, default)


def test_miniapp_list_reads_the_default_once(monkeypatch):
    rel, own = _project_with_sessions()
    reads, default = _count_default_reads(monkeypatch)
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj)
    h._api_sessions_list(CHAT, {"project": [rel]})
    assert len(reads) == 1
    _check(box["obj"]["sessions"], own, default)
