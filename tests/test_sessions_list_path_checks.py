"""A sessions list looks at each project's folder once, not once per session
(2026-11-27: 715 sessions in 62 projects made 21,000 lstat calls a build, half its
time, and one install had GET /local/sessions over 500 ms on every poll, Sentry's
MYSTICAL-9). A project that is gone still marks every one of its sessions.
Run: python -m pytest tests/test_sessions_list_path_checks.py -q"""

import os
import shutil
import uuid

from bridge import browser, config, store
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini

store.init()
CHAT = config.DASH_CHAT_ID


def _project(n):
    rel = f"/org/p-{uuid.uuid4().hex[:8]}"
    os.makedirs(os.path.join(config.BASE_PATH, rel.lstrip("/")), exist_ok=True)
    for _ in range(n):
        store.create_session(CHAT, rel, origin="dashboard")
    return rel


def _count(monkeypatch):
    asked = []
    for name in ("project_exists", "gone"):
        real = getattr(browser, name)
        monkeypatch.setattr(browser, name, lambda rel, real=real, name=name: asked.append((name, rel)) or real(rel))
    return asked


def _mini_list(rel):
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj)
    h._api_sessions_list(CHAT, {"project": [rel]})
    return box["obj"]


def test_each_project_is_looked_at_once_however_many_sessions_it_has(monkeypatch):
    here, moved = _project(6), _project(6)
    shutil.rmtree(os.path.join(config.BASE_PATH, moved.lstrip("/")))
    asked = _count(monkeypatch)
    for build in (lambda rel: dash._sessions_payload(CHAT, rel), _mini_list):
        for rel, missing in ((here, False), (moved, True)):
            asked.clear()
            assert [b["missing"] for b in build(rel)["sessions"]] == [missing] * 6
            assert len(asked) <= 3, asked   # the list's own look, and gone()'s at the folder
